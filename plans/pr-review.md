# Plan: PR-Aware Context Detection for Second Opinion

**Status:** Implemented (421 tests passing)

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
```

**Internal types:** `GhComment`, `GhReview`, `GhLabel`, `GhFile` — typed shapes for the raw `gh pr view --json` output (all fields optional). These replace inline type annotations on the `.map()` callbacks.

**Shared constant:** `SPAWN_OPTS` — `{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }` used by all three spawn call sites.

**Functions:**
- `isGhAvailable()` — check if `gh` CLI is installed via `spawnSync("gh", ["--version"])`
- `detectPR(projectPath, prNumber?)` — run `gh pr view [prNumber] --json number,title,body,url,state,baseRefName,headRefName,labels,comments,reviews,files` and parse. Return `null` on any failure (gh not installed, not authenticated, no PR). When `prNumber` is provided, view that specific PR; otherwise auto-detect from current branch.
- `getPRChangedFiles(projectPath, baseBranch)` — run `git diff <baseBranch>...HEAD --name-only` to get file paths. Map to absolute paths. This is a fallback/complement to the `files` field from `gh pr view`. **Note:** Not currently called from the bundler pipeline — `detectPR` gets files from `gh pr view` directly. Exported for future use or manual fallback.
- `formatPRMetadata(pr)` — format PR title, body, comments, and reviews as markdown. Run all text through `redactSecrets()` before inclusion.

**Error handling:** All failures return `null` silently (matching `git.ts` pattern). No thrown errors for missing `gh`, auth issues, or missing PRs.

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

**New step in `bundleContext()` between session (step 2) and git (step 3):**
1. Call `detectPR(projectPath, options.prNumber)`
2. If PR found:
   - Format PR metadata via `formatPRMetadata()` → store in `bundle.prContext`
   - Store structured metadata in `bundle.prMetadata`
   - Add PR metadata tokens to `bundle.totalTokens` (treated like conversation context — not charged against the PR file budget)
   - Read PR changed files as `FileEntry` with category `"pr"`
   - Add PR changed file paths to `modifiedFiles[]` so they feed into dependency/dependent/test/type resolution
   - Sort by token count (smaller first), process with `addFilesWithBudget`
3. If no PR found, call `getBudgetWithSpillover("pr", 0)` so the full PR budget spills over to later categories

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

Pass `prNumber` through to `bundleContext()` options.

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
| `src/context/pr.ts` | **New** — PR detection, metadata formatting |
| `src/context/pr.test.ts` | **New** — 19 tests for PR module |
| `src/utils/tokens.ts` | Add `pr` to budget allocation + priority order |
| `src/context/bundler.ts` | Add `pr` to types, pipeline step, format output; programmatic baseBudgets |
| `src/tools/review.ts` | Add `prNumber` param, pass through, update egress; simplify buildEgressSummary |
| `src/output/writer.ts` | Extend `EgressSummary` with `prContext` |
| `src/context/index.ts` | Add re-export |
| `src/server.ts` | Add `prNumber` to tool schema |
| `src/config.ts` | Increase `maxContextTokens` default from 100k to 200k |
| `src/config.test.ts` | Update expected default to 200000 |

## Existing code reused

- `spawnSync` pattern from `src/context/git.ts:93` (safe command execution)
- `readFileEntry()` from `src/context/bundler.ts` (file reading + redaction)
- `redactSecrets()` from `src/security/redactor.ts` (for PR body/comments)
- `addFilesWithBudget()` / `getBudgetWithSpillover()` from `src/context/bundler.ts` (budget management)
- `estimateTokens()` from `src/utils/tokens.ts`

## Verification

1. **Unit tests** — `src/context/pr.test.ts` (19 tests):
   - `isGhAvailable()` returns true/false based on gh exit status
   - `detectPR()` returns null when gh missing, no PR, or malformed JSON
   - `detectPR()` parses full gh JSON correctly including comments/reviews/labels/files
   - `detectPR()` handles missing optional fields gracefully
   - `detectPR()` passes explicit prNumber vs auto-detects
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

5. **`getPRChangedFiles` not wired into pipeline** — The plan listed it as a "fallback/complement" but the implementation gets files directly from `gh pr view --json files`. The function is exported but unused in the pipeline. Could be wired in as fallback if gh files field proves unreliable.

6. **`config.test.ts` updated** — Not in original plan's file list. Raising the default `maxContextTokens` broke an existing assertion that expected 100000.

7. **Step comment renumbering in `review.ts`** — The original code had duplicate step numbers (two 6s, two 7s, two 8s). Corrected during simplification to sequential 6-11.

## Lessons learned & notes for future

1. **Test token lengths against actual regex patterns.** The first PR test run had a failing test because a mock GitHub token (`ghp_abcdefghijklmnopqrstuvwxyz123456`, 32 chars after prefix) was shorter than the redactor's `{36,}` minimum. When writing tests that exercise secret redaction, always check the pattern lengths in `src/security/redactor.ts` and generate tokens that match.

2. **Changing defaults breaks assertion tests.** Any change to a schema default (like `maxContextTokens: 100000 → 200000`) will break tests that assert the default value. The plan should list affected test files proactively. Grep for the old default value across test files before committing to the change.

3. **Structured data vs formatted markdown.** When a pipeline step produces both human-readable output (markdown for the reviewer) and machine-readable data (for egress manifests, summaries), plan for both from the start. The need for `prMetadata` alongside `prContext` was foreseeable — the egress summary already had structured fields for redaction stats.

4. **Spillover budget for absent categories.** The no-PR case must still call `getBudgetWithSpillover("pr", 0)` so downstream categories receive the spillover. Missing this would silently halve the budget available to git/dependency/test categories. The `else` branch is easy to forget when the `if` branch is the interesting one.

5. **`gh pr view` returns files as `{ path: string }` objects, not plain strings.** The `--json files` field returns an array of objects with a `path` property, not an array of strings. The `GhFile` interface documents this. Future gh field additions may have similar wrapper shapes.

6. **`detectPR` calls `isGhAvailable` on every invocation.** This means two `spawnSync` calls per review (one for `gh --version`, one for `gh pr view`). If performance becomes a concern, consider caching the gh availability check for the lifetime of the process or the review call.
