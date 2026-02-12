# Plan: PR-Aware Context Detection for Second Opinion

**Status:** Implemented + hardened (421 tests passing)

## Context

When reviewing other people's PRs, the Claude Code session context is typically empty (you haven't read/edited files). But the current branch has an open PR with valuable context: the description, discussion comments, review comments, and the full set of changed files. Currently, second-opinion only looks at working tree changes (`git diff` vs HEAD) and Claude session files — neither captures the PR's actual changeset. This feature adds always-on PR detection so that PR metadata and changed files are automatically included as context alongside any existing session context.

## Implementation

### 1. New module: `src/context/pr.ts`

Create a PR detection module following the pattern of existing context modules (`git.ts`, `session.ts`).

**Public types:**
```typescript
interface PRContext {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  baseBranch: string;
  headBranch: string;
  labels: string[];
  comments: PRComment[];
  reviews: PRReview[];
  changedFiles: string[];
}

interface PRComment {
  author: string;
  body: string;
  createdAt: string;
}

interface PRReview {
  author: string;
  body: string;
  state: string;              // APPROVED, CHANGES_REQUESTED, COMMENTED
  createdAt: string;
}

type PRDetectionResult =
  | { ok: true; pr: PRContext }
  | { ok: false; reason: "gh_not_installed" | "gh_command_failed" | "no_pr_found" | "parse_error"; message: string };
```

**Internal types:** `GhComment`, `GhReview`, `GhLabel`, `GhFile` — typed shapes for the raw `gh pr view --json` output (all fields optional). These replace inline type annotations on the `.map()` callbacks.

**Shared constant:** `SPAWN_OPTS` — `{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }` used by all three spawn call sites.

**Functions:**
- `isGhAvailable()` — check if `gh` CLI is installed via `spawnSync("gh", ["--version"])`
- `detectPR(projectPath, prNumber?)` — run `gh pr view [prNumber] --json number,title,body,url,state,baseRefName,headRefName,labels,comments,reviews,files` and parse. Returns `PRDetectionResult` — a discriminated union with typed failure reasons (`gh_not_installed`, `gh_command_failed`, `no_pr_found`, `parse_error`) and user-facing messages. When `prNumber` is provided, view that specific PR; otherwise auto-detect from current branch. Falls back to `getPRChangedFiles` when `gh pr view` returns an empty files array.
- `getPRChangedFiles(projectPath, baseBranch)` — run `git diff <baseBranch>...HEAD --name-only` to get file paths. Map to absolute paths. Called as a fallback inside `detectPR` when `gh pr view --json files` returns an empty array but `baseBranch` is available.
- `formatPRMetadata(pr)` — format PR title, body, comments, and reviews as markdown. Run all text through `redactSecrets()` before inclusion.

**Error handling:** Returns typed `{ ok: false, reason, message }` for each failure mode. The `no_pr_found` case is treated as informational (not surfaced to the user). Other failures (`gh_not_installed`, `gh_command_failed`, `parse_error`) are stored as `prDetectionFailure` on the bundle and passed through to the tool output so the user understands why PR context is missing.

**Security:** Use `spawnSync` with argument arrays (never string interpolation). `prNumber` is validated as `z.number()` so safe to pass as `String(prNumber)`.

### 2. Update `src/utils/tokens.ts` — Budget allocation

Add `pr` category to budget allocation. When no PR exists, the 15% spills over to later categories, effectively restoring the original proportions:

```
explicit:   0.15  (unchanged)
session:    0.20  (was 0.30 — PR files cover the gap when reviewing)
pr:         0.15  (new — PR changed files)
git:        0.05  (was 0.10 — less important when PR context exists)
dependency: 0.15  (unchanged)
dependent:  0.15  (unchanged)
test:       0.10  (unchanged)
type:       0.05  (unchanged)
```

Add `"pr"` to `CATEGORY_PRIORITY_ORDER` between `session` and `git`.

### 3. Update `src/context/bundler.ts` — Pipeline integration

**Type changes:**
- Add `"pr"` to `FileEntry.category` union type
- Add `pr: number` to `ContextBundle.categories`
- Add `prContext?: string` to `ContextBundle` — the formatted PR metadata markdown
- Add `prMetadata?: { number, url, commentsCount, reviewsCount }` to `ContextBundle` — structured PR data for egress summary (not in original plan; added because `buildEgressSummary` needs structured data, not just the formatted markdown string)
- Add `prDetectionFailure?: { reason, message }` to `ContextBundle` — set when PR detection fails for a non-trivial reason (not `no_pr_found`)

**New step in `bundleContext()` between session (step 2) and git (step 3):**
1. Call `detectPR(projectPath, options.prNumber)` — returns `PRDetectionResult`
2. If `result.ok`:
   - Format PR metadata via `formatPRMetadata()` → store in `bundle.prContext`
   - Store structured metadata in `bundle.prMetadata`
   - Add PR metadata tokens to `bundle.totalTokens` (treated like conversation context — not charged against the PR file budget)
   - **Validate PR changed files before reading:** each path is checked with `isSensitivePath()` and `isWithinProject()`, matching the validation in `expandPath()`. Blocked files go to `omittedFiles` with appropriate reason.
   - Read validated PR changed files as `FileEntry` with category `"pr"`
   - Add PR changed file paths to `modifiedFiles[]` so they feed into dependency/dependent/test/type resolution
   - Sort by token count (smaller first), process with `addFilesWithBudget`
3. If `!result.ok`:
   - If `reason !== "no_pr_found"`, store `{ reason, message }` as `bundle.prDetectionFailure`
   - Call `getBudgetWithSpillover("pr", 0)` so the full PR budget spills over to later categories

**`BundleOptions` change:** Add `prNumber?: number`

**`formatBundleAsMarkdown()` changes:**
- After conversation context, render `bundle.prContext` if present (followed by `---` separator)
- Add `pr: []` to the categories record
- Add `"pr": "Pull Request Changed Files"` to `categoryLabels`

**Simplification applied during code review:** `baseBudgets` built programmatically via `Object.fromEntries(Object.entries(BUDGET_ALLOCATION).map(...))` instead of listing all 8 categories manually. Removed unused `CATEGORY_PRIORITY_ORDER` import.

### 4. Update `src/tools/review.ts` — Tool parameter

Add `prNumber` to `SecondOpinionInputSchema`:
```typescript
prNumber: z.number().optional()
  .describe("PR number to review. Auto-detects from current branch if omitted.")
```

Pass `prNumber` through to `bundleContext()` options. Pass `bundle.prDetectionFailure` through to both `SecondOpinionOutput` and `SecondOpinionDryRunOutput` so the caller sees why PR context is absent.

Update `buildEgressSummary()` to include PR metadata in the egress summary when present:
```typescript
prContext?: {
  prNumber: number;
  prUrl: string;
  commentsIncluded: number;
  reviewsIncluded: number;
}
```

**Simplification applied during code review:** `buildEgressSummary` rewritten to use `filter/map` chains and destructuring instead of imperative loop. Misnumbered step comments (duplicate 6/7/8) corrected to sequential 6-11.

### 5. Update `src/output/writer.ts` — Egress summary

Add optional `prContext` field to `EgressSummary` interface.

### 6. Update `src/context/index.ts` — Re-export

Add `export * from "./pr.js"`.

### 7. Update `src/server.ts` — Tool listing

Add `prNumber` to the MCP tool input schema definition.

### 8. Increase default `maxContextTokens` — `src/config.ts`

Raise the default from `100000` to `200000`. The current 100k budget is too tight for PR reviews — a 2k LOC PR with dependencies, dependents, tests, and types easily needs ~80-135k tokens. The configured models (`gemini-3-flash-preview` with 1M+ context, `gpt-5.2`) handle 200k comfortably. Users on older models can dial it down via config.

**Side effect:** Updated `src/config.test.ts` assertion from 100000 to 200000 to match new default.

## Files modified

| File | Change |
|------|--------|
| `src/context/pr.ts` | **New** — PR detection with `PRDetectionResult` return type, metadata formatting, `getPRChangedFiles` fallback |
| `src/context/pr.test.ts` | **New** — 21 tests for PR module (typed result assertions, fallback test, `gh_command_failed` test) |
| `src/utils/tokens.ts` | Add `pr` to budget allocation + priority order |
| `src/context/bundler.ts` | Add `pr` to types, pipeline step, format output; programmatic baseBudgets; `prDetectionFailure` field; path validation for PR files |
| `src/tools/review.ts` | Add `prNumber` param, pass through, update egress; simplify buildEgressSummary; remove `hasOmittedFiles`; add `prDetectionFailure` to output types |
| `src/providers/base.ts` | Replace conditional `CONTEXT_CALIBRATION` with always-on `VERIFICATION_REQUIREMENTS`; remove `hasOmittedFiles` from `ReviewRequest` and `getSystemPrompt()` |
| `src/providers/base.test.ts` | Update tests for always-on verification (replace 4 conditional tests with 2 always-on tests) |
| `src/providers/gemini.ts` | Remove `hasOmittedFiles` from `getSystemPrompt()` call |
| `src/providers/openai.ts` | Remove `hasOmittedFiles` from `getSystemPrompt()` call |
| `src/output/writer.ts` | Extend `EgressSummary` with `prContext` |
| `src/context/index.ts` | Add re-export |
| `src/server.ts` | Add `prNumber` to tool schema |
| `src/config.ts` | Increase `maxContextTokens` default from 100k to 200k |
| `src/config.test.ts` | Update expected default to 200000 |
| `templates/second-opinion.md` | Add required `**Evidence**` field to Critical Issues; strengthen citation guidelines |
| `.gitignore` | Add `coverage/` |
| `README.md` | Document `gh` CLI as optional dependency; add PR context to feature list |

## Existing code reused

- `spawnSync` pattern from `src/context/git.ts:93` (safe command execution)
- `readFileEntry()` from `src/context/bundler.ts` (file reading + redaction)
- `redactSecrets()` from `src/security/redactor.ts` (for PR body/comments)
- `addFilesWithBudget()` / `getBudgetWithSpillover()` from `src/context/bundler.ts` (budget management)
- `estimateTokens()` from `src/utils/tokens.ts`

## Verification

1. **Unit tests** — `src/context/pr.test.ts` (21 tests):
   - `isGhAvailable()` returns true/false based on gh exit status
   - `detectPR()` returns `{ ok: false, reason: "gh_not_installed" }` when gh missing
   - `detectPR()` returns `{ ok: false, reason: "no_pr_found" }` when no PR for branch
   - `detectPR()` returns `{ ok: false, reason: "gh_command_failed" }` on other gh errors (e.g. HTTP 403)
   - `detectPR()` returns `{ ok: false, reason: "parse_error" }` on malformed JSON
   - `detectPR()` parses full gh JSON correctly including comments/reviews/labels/files
   - `detectPR()` handles missing optional fields gracefully
   - `detectPR()` passes explicit prNumber vs auto-detects
   - `detectPR()` falls back to `getPRChangedFiles` when gh returns empty files array
   - `getPRChangedFiles()` returns absolute paths, empty array on failure
   - `formatPRMetadata()` includes all fields, redacts secrets in body/comments
   - `formatPRMetadata()` omits empty sections

2. **Full test suite** — 421 tests across 18 files, all passing.

3. **Integration test** — Check out a real PR branch, run:
   ```
   /second-opinion dryRun=true
   ```
   Verify PR files and metadata appear in the dry run output.

4. **Manual test** — Run on a PR branch:
   ```
   /second-opinion Review this PR for correctness and style
   ```
   Verify the review file includes PR context sections.

## Alterations from original plan

1. **Added `prMetadata` to `ContextBundle`** — The plan only specified `prContext?: string` (formatted markdown). During implementation, `buildEgressSummary` needed structured data (PR number, URL, comment/review counts) for the egress manifest. Added a `prMetadata` field with these values rather than re-parsing the markdown or re-calling `detectPR`.

2. **Added `GhComment`/`GhReview`/`GhLabel`/`GhFile` internal interfaces** — Not in original plan. Added during simplification pass to replace verbose inline type annotations on `JSON.parse` results. Makes the `.map()` callbacks in `detectPR` cleaner.

3. **Added `SPAWN_OPTS` shared constant** — Not in original plan. Extracted during simplification to eliminate identical `{ encoding, stdio }` objects across three call sites.

4. **`baseBudgets` built programmatically** — Original plan didn't specify construction method. The initial implementation listed all 8 categories manually. Simplification pass replaced with `Object.fromEntries` + `Object.entries(BUDGET_ALLOCATION).map(...)`.

5. **`getPRChangedFiles` initially not wired into pipeline** — The plan listed it as a "fallback/complement" but the initial implementation got files directly from `gh pr view --json files` only. The function was exported but unused. **Resolved in hardening pass:** now called as fallback inside `detectPR` when `gh pr view` returns an empty files array but `baseBranch` is available.

6. **`config.test.ts` updated** — Not in original plan's file list. Raising the default `maxContextTokens` broke an existing assertion that expected 100000.

7. **Step comment renumbering in `review.ts`** — The original code had duplicate step numbers (two 6s, two 7s, two 8s). Corrected during simplification to sequential 6-11.

## Lessons learned & notes for future

1. **Test token lengths against actual regex patterns.** The first PR test run had a failing test because a mock GitHub token (`ghp_abcdefghijklmnopqrstuvwxyz123456`, 32 chars after prefix) was shorter than the redactor's `{36,}` minimum. When writing tests that exercise secret redaction, always check the pattern lengths in `src/security/redactor.ts` and generate tokens that match.

2. **Changing defaults breaks assertion tests.** Any change to a schema default (like `maxContextTokens: 100000 → 200000`) will break tests that assert the default value. The plan should list affected test files proactively. Grep for the old default value across test files before committing to the change.

3. **Structured data vs formatted markdown.** When a pipeline step produces both human-readable output (markdown for the reviewer) and machine-readable data (for egress manifests, summaries), plan for both from the start. The need for `prMetadata` alongside `prContext` was foreseeable — the egress summary already had structured fields for redaction stats.

4. **Spillover budget for absent categories.** The no-PR case must still call `getBudgetWithSpillover("pr", 0)` so downstream categories receive the spillover. Missing this would silently halve the budget available to git/dependency/test categories. The `else` branch is easy to forget when the `if` branch is the interesting one.

5. **`gh pr view` returns files as `{ path: string }` objects, not plain strings.** The `--json files` field returns an array of objects with a `path` property, not an array of strings. The `GhFile` interface documents this. Future gh field additions may have similar wrapper shapes.

6. **`detectPR` calls `isGhAvailable` on every invocation.** This means two `spawnSync` calls per review (one for `gh --version`, one for `gh pr view`). If performance becomes a concern, consider caching the gh availability check for the lifetime of the process or the review call.

7. **Silent `null` returns hide actionable failures.** The original `detectPR` returned `null` for every failure — gh not installed, auth error, no PR, parse error. The user had no way to know *why* PR context was missing. Discriminated unions with typed failure reasons (`PRDetectionResult`) cost minimal code but dramatically improve debuggability. Apply this pattern to any function where "didn't work" has multiple distinct causes the caller could act on.

8. **Models hallucinate about code in context, not just missing code.** The consensus review false positives occurred with full files in context — GPT-5.2 claimed `realpathSync()` was absent from `bundler.ts` when it was at line 141, and fabricated a code snippet for `config.ts`. The `hasOmittedFiles` gate on verification instructions was therefore insufficient. Anti-hallucination defenses must be always-on, not conditional on context completeness.

9. **Require evidence in the output format, not just the prompt.** Telling the model "verify your claims" in the system prompt is necessary but not sufficient. Adding a structured `**Evidence**: quote (file:line)` field to the Critical Issues template makes it structurally harder to assert a vulnerability without citing code. Defense in depth: system prompt sets the expectation, template format enforces it.

10. **PR changed files from `gh` bypass path validation.** The initial implementation read PR changed files via `readFileEntry()` without the `isSensitivePath()` / `isWithinProject()` checks that `expandPath()` applies to other file categories. Any external data source that produces file paths (CLI output, API responses, config files) should be validated before reading, even if the source is trusted.

11. **Consensus reviews generate false positives at a meaningful rate.** Three of six "critical" findings from the Gemini + OpenAI consensus review were false positives. When consuming automated review output, treat Critical Issues as hypotheses until verified against the actual code. The evidence requirement added to the template helps, but human verification of critical findings remains essential.
