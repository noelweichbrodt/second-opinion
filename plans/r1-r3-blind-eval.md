# R1/R3 blind quality evaluation — execution plan

Decides whether two deferred prompt trims from `plans/token-audit.md` can land without degrading review quality. Per the audit's acceptance criteria: blind baseline-vs-candidate evaluation across the named quality dimensions; **no quality metric may regress; token savings alone cannot win**; each candidate is evaluated independently so regressions are attributable.

Authored 2026-07-27 by the C-suite session that ran the token audit. Context: `.claude/narrative.md` (2026-07-27 entries).

## Candidates (FROZEN — do not reword during the eval)

Both replace prompt text in `src/providers/`. The working tree is uncommitted-but-accepted; **back up the two files with `cp` before patching and restore byte-exact afterward (`cmp`) — do not use git checkout/restore.**

### R1 — review system-prompt nucleus (`src/providers/base.ts`, `getSystemPrompt`, review branch)

Baseline (measured 1,158 B including `VERIFICATION_REQUIREMENTS`): the current `base + VERIFICATION_REQUIREMENTS` return value for `hasTask=false`.

Candidate (replaces the entire review-branch return value, ~370 B; retains role, follow-methodology, verified-only findings, quoted BLOCKING evidence, Questions routing, absence search):

```text
You are a staff software engineer performing a code review. Follow the review methodology in <instructions>. Report only issues you can verify in the provided code. Quote the code for [BLOCKING] findings. If you suspect an issue but cannot locate confirming code, list it under Questions, not as a confirmed finding. Search the full provided context before claiming something doesn't exist.
```

Task-mode prompt (`TASK_SYSTEM_PROMPT`) is out of scope — leave it untouched.

### R3 — Codex review-handoff header (`src/providers/codex.ts`, `CODEX_REVIEW_HANDOFF_HEADER`)

Baseline (measured 260 B): the current header. Candidate (~125 B; keeps the read-only boundary and complete-markdown instruction; drops the role/grounding restatement that the system prompt below it already carries):

```text
# Codex Review Handoff

- This is a read-only task. Do not modify any files.
- Produce the complete review markdown as your final message.
```

`CODEX_TASK_HANDOFF_HEADER` is out of scope — leave it untouched.

## Arms and run matrix

| Arm | base.ts | codex.ts | Engines affected |
|---|---|---|---|
| A (baseline) | current | current | both |
| B (R1) | candidate | current | both |
| C (R3) | current | candidate | Codex only (header never reaches Gemini) |
| D (R1+R3) | candidate | candidate | Codex only — **run only if B and C both pass**, as a cheap interaction check |

Runs: **Gemini** — arms A,B × 8 fixtures × 1 rep (temperature 0) = 16 calls. **Codex** — arms A,B,C × 8 fixtures × 1 rep = 24 background runs (gpt-5.6-sol, no `--effort`, read-only), max 2 concurrent; +8 for D if triggered. Rebuild (`npm run build`) after each arm switch; comparisons are paired per fixture.

## Fixture corpus (build first, before any patching)

Eight standalone mini-projects, each a git repo: base commit = working code, feature branch = the diff under review. 3-6 TypeScript files, <400 lines total each. **Ground truth lives OUTSIDE the fixture repo** (sibling `truth.yaml`) so it can never enter the egress bundle. Layout: `<workdir>/fixtures/<name>/repo/` + `<workdir>/fixtures/<name>/truth.yaml`, where `<workdir>` is the executing session's scratch area.

| Fixture | Seeds (in-diff) | Extras |
|---|---|---|
| fx-null-contract | consumer added without a null path on a `T \| null` API [BLOCKING] | 1 pre-existing null mishandling outside the diff [IMPORTANT] |
| fx-sql-injection | string-interpolated query [BLOCKING] | trap: a nearby correctly-parameterized query (flagging it = fabrication) |
| fx-swallowed-error | catch block drops the error, returns default [IMPORTANT] | pre-existing unhandled promise rejection |
| fx-race | check-then-act on a shared map [IMPORTANT] | — |
| fx-perf-unbounded | N+1 fetch loop without pagination [IMPORTANT] | trap: a bounded lookalike loop |
| fx-reachability-trap | none — the diff adds an internal helper reachable only with already-validated input | trap: "add a guard" must be demoted to [NIT]/[SUGGESTION] with a reachability note per the methodology |
| fx-boundary-refactor | validation moved, leaving the API handler unguarded at a genuine trust boundary [BLOCKING] | correct fix altitude = one boundary validation, not scattered guards |
| fx-clean | none — a competent small refactor | honesty check: zero [BLOCKING]/[IMPORTANT] findings expected |

`truth.yaml` schema per fixture:

```yaml
clean: false
defects:
  - id: D1
    file: src/db.ts
    lines: [12, 18]
    category: security
    min_severity: BLOCKING
    in_diff: true
    description: ...
traps:
  - id: T1
    kind: reachability-demotion   # or lookalike-clean
    file: src/util.ts
    description: loud flagging is a penalty; a demoted mention is acceptable
```

Review invocation per run: import `executeReview` from `dist/tools/review.js` with `provider` gemini/codex, `projectPath` = fixture repo (feature branch checked out), `includeConversation: false`, `temperature: 0` (Gemini), unique `sessionName` = `<fixture>-<arm>`. Gemini reviews land in the fixture's `second-opinions/`; for Codex, launch the returned rescue work via `codex-companion.mjs task --background` (path in `.claude/narrative.md` entries), poll `status --json`, and extract `result.rawOutput` from `result <job> --json`. `GEMINI_API_KEY` comes from `~/.secrets/gemini-key` per the README convention; pace Gemini calls under the default 10/60s limit. Checkpoint progress to a JSON file after every run so an interrupted session can resume.

## Blinding and judging

1. After all runs, copy each review body to `judging/<fixture>/<engine>/<random8>.md`. Record the id→arm map in `judging/manifest.json`. **No grader or judge ever sees the manifest, arm names, prompt texts, or the fact that prompts differ.**
2. **Objective rubric (primary)** — one cold subagent per review (fresh context; never the session that knows the arms). Input: the fixture's `truth.yaml`, the fixture source (repo tree at the feature branch), and one review text. Output JSON: per defect `{found, file_line_correct, severity_at_or_above_floor}`; `fabricated_findings` (count of findings asserting code/behavior not present in the fixture); per trap `{handled: demoted|loud_fp|not_mentioned}`; `diff_classification: correct|misfiled|n/a` (in-diff findings under Findings, pre-existing under Pre-existing Issues); `format_ok` (required sections + severity labels); for fx-clean, `honesty: pass|fail`.
3. **Pairwise preference (secondary)** — per fixture/engine, a cold judge gets the baseline and candidate reviews labeled `R1`/`R2` in random order: "which review would better serve the author — R1, R2, or tie?" Repeat once with order swapped; count only order-consistent preferences.

## Metrics and decision rule

Per candidate (B vs A per engine; C vs A on Codex), paired per fixture: (1) weighted in-diff recall (BLOCKING=3, IMPORTANT=2, else 1); (2) pre-existing recall; (3) fabrication count; (4) evidence (file:line) accuracy; (5) diff-classification accuracy; (6) trap handling; (7) format compliance; (8) clean-fixture honesty.

**A candidate LANDS only if all hold:**
- (a) no metric shows net paired regressions (fixtures lost > fixtures won);
- (b) no BLOCKING-floor defect is found by baseline but missed by the candidate in the same fixture, unless offset by an equal-or-higher-severity gain in that fixture;
- (c) fx-clean honesty does not degrade;
- (d) net fabrications do not increase.

Ties across the board → land (the savings win ties). Pairwise preference is reported but never overrides the rubric. Report the outcome either way in `plans/r1-r3-eval-results.md`: per-metric paired tables, the decision per candidate, judging manifest, and total tokens spent on the eval.

## Landing phase (conditional)

If a candidate passes: restore backups, apply the frozen candidate text properly in `src/`, update `base.test.ts`/`codex.test.ts` expectations, run the full suite and build, re-measure the savings, then route the diff through Staff Engineer review per the stallions protocol before acceptance. Update `.claude/narrative.md`. If a candidate fails: restore backups, record the failure and the specific regressing metric — the deferral becomes permanent unless a new candidate is proposed.

## Hard constraints

- Never edit `templates/second-opinion.md`. Never commit or revert the working tree. Never add a reasoning-effort option or `--effort` flag.
- Restore `src/providers/base.ts` and `src/providers/codex.ts` byte-exact (`cmp` against the `cp` backups) before the landing phase or on abort.
- Candidates are frozen; if a candidate looks obviously broken mid-eval, abort and report — do not iterate on wording inside the eval.
- Expected cost: ~16 Gemini calls, 24-32 ultra-effort Codex background runs (2-4 h wall clock at ≤2 concurrent), ~40-56 cold grader/judge subagents.
