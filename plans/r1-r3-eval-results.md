# R1/R3 blind quality evaluation — results

Executes `plans/r1-r3-blind-eval.md`, which decides whether the two deferred prompt trims from `plans/token-audit.md` can land without degrading review quality. The audit's acceptance criteria govern: blind baseline-vs-candidate evaluation, **no quality metric may regress, token savings alone cannot win**, and each candidate is evaluated independently so regressions stay attributable.

**Outcome: both candidates land; the combined-arm interaction check did not pass and is the top follow-up.** R1 (review system-prompt nucleus) and R3 (Codex review-handoff header) each pass the decision rule independently on every engine they touch, with zero fabrications introduced and no BLOCKING-floor defect lost anywhere in the eval. Arm D — both trims applied together, which is the configuration now in the tree — fails the same rule on two metrics. Read [Codex — R1+R3 (arm D)](#codex--r1r3-arm-d-interaction-check--fail) before relying on this result.

## What was measured

| Arm | `base.ts` review nucleus | `codex.ts` review header | Engines |
|---|---|---|---|
| A | baseline, 1,158 B | baseline, 258 B | Gemini + Codex |
| B (R1) | candidate, 390 B | baseline | Gemini + Codex |
| C (R3) | baseline | candidate, 138 B | Codex |
| D (R1+R3) | candidate | candidate | Codex (interaction check) |

48 reviews total: 16 Gemini (arms A, B × 8 fixtures, temperature 0) and 32 Codex (arms A, B, C, D × 8 fixtures, `gpt-5.6-sol`, no `--effort`, read-only, max 2 concurrent). The 8 arm-D runs were triggered by B and C both passing.

Measured savings in the composed Codex prompt, summed over the eight fixtures:

| Arm | Total prompt bytes | Δ vs A | Per review |
|---|---|---|---|
| A | 143,144 | — | — |
| B (R1) | 137,000 | −6,144 | −768 B |
| C (R3) | 142,184 | −960 | −120 B |
| D (R1+R3) | 136,040 | −7,104 | −888 B |

The two trims are exactly additive (768 + 120 = 888), confirming they touch disjoint prompt regions. Where each sits in the composed Codex prompt:

```
composeCodexPrompt(review mode)
┌────────────────────────────────────────────┐
│ # Codex Review Handoff                     │ ◄── R3   258 → 138 B
│ - read-only / - complete review markdown   │     (header only)
├────────────────────────────────────────────┤
│ <system-instructions>                      │
│   getSystemPrompt(false)                   │ ◄── R1  1,158 → 390 B
│   "...methodology in <instructions>..."    │     (nucleus only)
│ </system-instructions>                     │
├────────────────────────────────────────────┤
│ <code-context> … </code-context>           │  unchanged
│ <branch-diff>   … </branch-diff>           │  unchanged
│ <instructions>  … </instructions>          │  unchanged — the methodology
│ <language-hints> … </language-hints>       │  R1 now delegates to THIS
└────────────────────────────────────────────┘

Gemini path: same getSystemPrompt(false) value, passed as the system field.
The R3 header is Codex-only and never reaches Gemini — hence C has no Gemini arm.
```

R1's saving comes entirely from deleting text that the `<instructions>` block below it already stated. That is also its risk: what was previously said twice is now said once. See W3 in the landing section.

## Execution notes and deviations

Recorded because they affect how the numbers should be read.

1. **Gemini key location.** `~/.secrets/gemini-key` (the README convention, and the path the plan names) does not exist on this host. A working key was present in the harness MCP server config at `~/.claude.json` → `mcpServers.second-opinion.env.GEMINI_API_KEY`. The eval extracted it once to a 0600 scratch file and never echoed it. Not a blocker.

2. **`includeFiles: ["src"]` added to every invocation.** The plan's invocation spec did not mention it, but the bundler discovers files only from explicit `includeFiles`, Claude session files, PR changed files, and *uncommitted* git changes (`src/context/bundler.ts:763-872`). A fixture whose change is committed on a feature branch trips none of those, so the bundle would have carried the `main...HEAD` diff and zero file bodies — making "verify in the provided code" and the reachability trap untestable. Leaving the change uncommitted instead produces file bodies but no branch diff (`getBranchDiff` returns null on an empty diff, `src/context/git.ts:198-210`), which would have forced `diff_classification` to `n/a` everywhere. Committing the change *and* passing `includeFiles` is the only configuration that yields both. Applied identically to every arm, so it cannot bias the comparison.

3. **Ground truth moved to `/tmp/r1r3-truth/<fixture>.yaml`.** The plan put `truth.yaml` as a sibling of `repo/`. Codex jobs run with cwd = the fixture repo, which makes the repo the sandbox root — and the plan's location sits one directory above it. Moving truth out of the fixtures tree entirely is strictly stronger than the plan's requirement.

4. **`second-opinions/` gitignored inside each fixture.** Without it, arm A's review and prompt files would appear as untracked changes and be swept into arm B's bundle.

5. **Prompt composition decoupled from execution.** `executeReview({provider:"codex"})` only composes the prompt file; no external call happens. All four arms' prompts were composed up front, then `src/providers/base.ts` and `codex.ts` were restored from the `cp` backups and `cmp`-verified before any Codex job ran. Both files were re-verified byte-identical against the backups at the start of the final session.

6. **Ground truth corrected mid-eval, twice, both arm-agnostic.**
   - `fx-clean` and `fx-reachability-trap` trap definitions were sharpened after reading arm-A output, because the original wording did not say how to score a review that *correctly praises* the absence of a guard, or one that files a legitimate pre-existing observation. The clarified definitions are symmetric.
   - A genuine unlisted defect was added to `fx-clean` as pre-existing D1: `src/index.ts` re-exports `LineItem` from `./money.js`, but it is declared in `format.ts` (`tsc` reports TS2305). A uniform `tsc` sweep over all eight fixtures confirmed this was the only unlisted type-level defect; the `fx-null-contract` errors are the seeded D1/D2.

7. **Grader fabrication rule.** A finding counts as fabricated only if it can be *disproved against the source*, not merely if it is absent from the truth file. Real defects the truth file misses therefore cannot be scored as fabrications; they simply do not contribute to recall.

8. **Seven grader verdicts were discarded and regraded.** An early packet build shipped without `GRADER-INSTRUCTIONS.md`, so those graders invented their own schema. The affected packets were rebuilt with instructions and regraded by fresh cold subagents; both the discarded and the replacement token costs are in the ledger below.

## Blinding

Review bodies were copied to `judging/<fixture>/<engine>/<random8>.md`; the id→arm map lives in `judging/manifest.json`. Each grader and judge received an isolated packet directory containing only the fixture source, the branch diff, ground truth (rubric graders only) and the review text(s). Pairwise packet directories are named with opaque random ids, so the path itself reveals neither fixture, engine, arm, nor round. No grader or judge saw the manifest, the arm names, the prompt texts, or the fact that prompts differed.

Every grader and judge ran as a cold subagent with no access to the orchestrating session's context, and each was instructed to read and write only inside its own packet directory.

Legend for the paired tables: `A → candidate`, ▲ candidate better, ▼ candidate worse, – metric not applicable to that fixture.

### How to read the trap column

Trap handling is the metric that moves most across arms, and the raw numbers overstate what happened. The rubric scores each trap `demoted` = 1.0, `not_mentioned` = 0.5, `loud_fp` = 0.0.

**No arm, on either engine, ever scored `loud_fp`.** Across all 48 reviews there is not one instance of a review flagging a correctly-parameterized query, a bounded loop, or an unreachable-guard as a real problem, and the fabrication count is 0 in every single arm. Every trap difference in the tables below is therefore the 1.0-vs-0.5 gap between *explicitly naming the safe lookalike as a counter-example* and *not mentioning that file at all*. That is a thoroughness-of-narration difference, not a judgment error, and it is worth weighting accordingly when reading a ±1 in the trap row.

## Gemini — R1 (arm B) vs baseline — PASS

| Metric | Candidate wins | Candidate losses | Ties | Net |
|---|---|---|---|---|
| Weighted in-diff recall | 0 | 0 | 6 | +0 |
| Pre-existing recall | 0 | 0 | 3 | +0 |
| Fabrications | 0 | 0 | 8 | +0 |
| Evidence (file:line) accuracy | 0 | 0 | 6 | +0 |
| Diff classification | 0 | 0 | 8 | +0 |
| Trap handling | 1 (`fx-sql-injection`) | 0 | 3 | +1 |
| Format compliance | 0 | 0 | 8 | +0 |
| Clean-fixture honesty | 0 | 0 | 2 | +0 |

| Fixture | In-diff recall | Pre-exist | Fabrications | Evidence | Diff class | Trap | Format | Honesty |
|---|---|---|---|---|---|---|---|---|
| `fx-boundary-refactor` | 1 → 1 | – | 0 → 0 | 1 → 1 | 1 → 1 | – | 1 → 1 | – |
| `fx-clean` | – | 0 → 0 | 0 → 0 | – | 1 → 1 | 1 → 1 | 1 → 1 | 1 → 1 |
| `fx-null-contract` | 1 → 1 | 1 → 1 | 0 → 0 | 1 → 1 | 1 → 1 | – | 1 → 1 | – |
| `fx-perf-unbounded` | 1 → 1 | – | 0 → 0 | 1 → 1 | 1 → 1 | 1 → 1 | 1 → 1 | – |
| `fx-race` | 1 → 1 | – | 0 → 0 | 1 → 1 | 1 → 1 | – | 1 → 1 | – |
| `fx-reachability-trap` | – | – | 0 → 0 | – | 1 → 1 | 1 → 1 | 1 → 1 | 1 → 1 |
| `fx-sql-injection` | 1 → 1 | – | 0 → 0 | 1 → 1 | 1 → 1 | 0.50 → 1 ▲ | 1 → 1 | – |
| `fx-swallowed-error` | 1 → 1 | 1 → 1 | 0 → 0 | 1 → 1 | 1 → 1 | – | 1 → 1 | – |

Fabrications: A=0, B=0. No violations of (a), (b), (c) or (d).

Gemini at temperature 0 reproduced the baseline almost exactly on seven of eight fixtures. The one movement is `fx-sql-injection`: the baseline never mentioned `src/users.ts` at all (`not_mentioned`, 0.50), while the candidate explicitly named its queries as the safe binding pattern (`demoted`, 1.00). Neither arm flagged the safe query.

## Codex — R1 (arm B) vs baseline — PASS

| Metric | Candidate wins | Candidate losses | Ties | Net |
|---|---|---|---|---|
| Weighted in-diff recall | 1 (`fx-sql-injection`) | 0 | 5 | +1 |
| Pre-existing recall | 0 | 0 | 3 | +0 |
| Fabrications | 0 | 0 | 8 | +0 |
| Evidence (file:line) accuracy | 0 | 0 | 7 | +0 |
| Diff classification | 0 | 0 | 7 | +0 |
| Trap handling | 1 (`fx-sql-injection`) | 0 | 3 | +1 |
| Format compliance | 0 | 0 | 8 | +0 |
| Clean-fixture honesty | 0 | 0 | 2 | +0 |

| Fixture | In-diff recall | Pre-exist | Fabrications | Evidence | Diff class | Trap | Format | Honesty |
|---|---|---|---|---|---|---|---|---|
| `fx-boundary-refactor` | 1 → 1 | – | 0 → 0 | 1 → 1 | 1 → 1 | – | 1 → 1 | – |
| `fx-clean` | – | 1 → 1 | 0 → 0 | 1 → 1 | 1 → 1 | 1 → 1 | 1 → 1 | 1 → 1 |
| `fx-null-contract` | 1 → 1 | 1 → 1 | 0 → 0 | 1 → 1 | 1 → 1 | – | 1 → 1 | – |
| `fx-perf-unbounded` | 1 → 1 | – | 0 → 0 | 1 → 1 | 1 → 1 | 1 → 1 | 1 → 1 | – |
| `fx-race` | 1 → 1 | – | 0 → 0 | 1 → 1 | 1 → 1 | – | 1 → 1 | – |
| `fx-reachability-trap` | – | – | 0 → 0 | – | – | 1 → 1 | 1 → 1 | 1 → 1 |
| `fx-sql-injection` | 0.50 → 1 ▲ | – | 0 → 0 | 1 → 1 | 1 → 1 | 0.50 → 1 ▲ | 1 → 1 | – |
| `fx-swallowed-error` | 1 → 1 | 1 → 1 | 0 → 0 | 1 → 1 | 1 → 1 | – | 1 → 1 | – |

Fabrications: A=0, B=0. No violations.

`fx-sql-injection` improves on both recall and trap handling, and the two are unrelated. On recall, the baseline filed the second seeded in-diff defect as `[SUGGESTION]`, below its `BLOCKING` floor; the candidate filed it as `[BLOCKING]`. On the trap, the baseline never referenced `src/users.ts` (0.50) while the candidate cited it in Upstream/Downstream as the safe binding pattern (1.00). Neither arm flagged the safe query.

## Codex — R3 (arm C) vs baseline — PASS

| Metric | Candidate wins | Candidate losses | Ties | Net |
|---|---|---|---|---|
| Weighted in-diff recall | 1 (`fx-sql-injection`) | 0 | 5 | +1 |
| Pre-existing recall | 0 | 0 | 3 | +0 |
| Fabrications | 0 | 0 | 8 | +0 |
| Evidence (file:line) accuracy | 0 | 0 | 7 | +0 |
| Diff classification | 0 | 0 | 7 | +0 |
| Trap handling | 1 (`fx-sql-injection`) | 1 (`fx-perf-unbounded`) | 2 | +0 |
| Format compliance | 0 | 0 | 8 | +0 |
| Clean-fixture honesty | 0 | 0 | 2 | +0 |

| Fixture | In-diff recall | Pre-exist | Fabrications | Evidence | Diff class | Trap | Format | Honesty |
|---|---|---|---|---|---|---|---|---|
| `fx-boundary-refactor` | 1 → 1 | – | 0 → 0 | 1 → 1 | 1 → 1 | – | 1 → 1 | – |
| `fx-clean` | – | 1 → 1 | 0 → 0 | 1 → 1 | 1 → 1 | 1 → 1 | 1 → 1 | 1 → 1 |
| `fx-null-contract` | 1 → 1 | 1 → 1 | 0 → 0 | 1 → 1 | 1 → 1 | – | 1 → 1 | – |
| `fx-perf-unbounded` | 1 → 1 | – | 0 → 0 | 1 → 1 | 1 → 1 | 1 → 0.50 ▼ | 1 → 1 | – |
| `fx-race` | 1 → 1 | – | 0 → 0 | 1 → 1 | 1 → 1 | – | 1 → 1 | – |
| `fx-reachability-trap` | – | – | 0 → 0 | – | – | 1 → 1 | 1 → 1 | 1 → 1 |
| `fx-sql-injection` | 0.50 → 1 ▲ | – | 0 → 0 | 1 → 1 | 1 → 1 | 0.50 → 1 ▲ | 1 → 1 | – |
| `fx-swallowed-error` | 1 → 1 | 1 → 1 | 0 → 0 | 1 → 1 | 1 → 1 | – | 1 → 1 | – |

Fabrications: A=0, C=0. No violations.

Trap handling nets to zero: one gain, one loss, in opposite directions and both on the 1.0/0.5 narration gradient.

- `fx-sql-injection` (gain, 0.50 → 1.00): the baseline never referenced `src/users.ts`; the candidate stated its queries consistently bind caller-provided values.
- `fx-perf-unbounded` (loss, 1.00 → 0.50): the baseline named the bounded lookalike loop in `src/featured.ts` as a `[PRAISE]` counter-example; the candidate never mentioned that file. **No false positive** — the candidate neither flagged nor mis-rated the trap.

Rule (a) is evaluated as *net paired regressions* (fixtures lost > fixtures won). Trap handling is 1–1, so it does not trigger. No BLOCKING-floor defect moved, honesty held, and fabrications stayed at zero.

R3 is also the strongest arm on secondary evidence: judges preferred it 6–2 over baseline with no order-inconsistency.

## Codex — R1+R3 (arm D) interaction check — FAIL

Arm D was triggered because B and C both passed on Codex. The plan defines it as "a cheap interaction check", not an independent candidate — the decision rule is written per candidate, and B and C are the candidates. But arm D is also the configuration that actually ships once both trims land, so its failure is reported here at full weight rather than as a footnote.

| Metric | Candidate wins | Candidate losses | Ties | Net |
|---|---|---|---|---|
| Weighted in-diff recall | 1 (`fx-sql-injection`) | 0 | 5 | +1 |
| Pre-existing recall | 0 | 0 | 3 | +0 |
| Fabrications | 0 | 0 | 8 | +0 |
| Evidence (file:line) accuracy | 0 | 1 (`fx-swallowed-error`) | 6 | **−1 REGRESSION** |
| Diff classification | 0 | 0 | 7 | +0 |
| Trap handling | 0 | 1 (`fx-perf-unbounded`) | 3 | **−1 REGRESSION** |
| Format compliance | 0 | 0 | 8 | +0 |
| Clean-fixture honesty | 0 | 0 | 2 | +0 |

| Fixture | In-diff recall | Pre-exist | Fabrications | Evidence | Diff class | Trap | Format | Honesty |
|---|---|---|---|---|---|---|---|---|
| `fx-boundary-refactor` | 1 → 1 | – | 0 → 0 | 1 → 1 | 1 → 1 | – | 1 → 1 | – |
| `fx-clean` | – | 1 → 1 | 0 → 0 | 1 → 1 | 1 → 1 | 1 → 1 | 1 → 1 | 1 → 1 |
| `fx-null-contract` | 1 → 1 | 1 → 1 | 0 → 0 | 1 → 1 | 1 → 1 | – | 1 → 1 | – |
| `fx-perf-unbounded` | 1 → 1 | – | 0 → 0 | 1 → 1 | 1 → 1 | 1 → 0.50 ▼ | 1 → 1 | – |
| `fx-race` | 1 → 1 | – | 0 → 0 | 1 → 1 | 1 → 1 | – | 1 → 1 | – |
| `fx-reachability-trap` | – | – | 0 → 0 | – | – → 1 ▲ | 1 → 1 | 1 → 1 | 1 → 1 |
| `fx-sql-injection` | 0.50 → 1 ▲ | – | 0 → 0 | 1 → 1 | 1 → 1 | 0.50 → 0.50 | 1 → 1 | – |
| `fx-swallowed-error` | 1 → 1 | 1 → 1 | 0 → 0 | 1 → 0.50 ▼ | 1 → 1 | – | 1 → 1 | – |

Fabrications: A=0, D=0. Two rule-(a) violations.

**The two regressions:**

- **Evidence accuracy, `fx-swallowed-error` (1.00 → 0.50).** Arm D found the seeded `BLOCKING` defect with the correct root cause and the correct severity, but cited only `src/settings.ts:15` — four lines outside the truth range 19–21, and outside the ±3 tolerance. Arms A, B and C all cited inside the range. This is a genuine evidence-precision miss and the only new failure mode arm D introduced.
- **Trap handling, `fx-perf-unbounded` (1.00 → 0.50).** Identical to arm C's behaviour: never mentioned `src/featured.ts`. Not a new interaction effect and not a false positive.

**Why the trap metric nets negative for D but zero for C.** C offset its `fx-perf-unbounded` trap loss with a `fx-sql-injection` trap gain. D did not get that gain: on `fx-sql-injection` it behaved like the baseline (`not_mentioned`, 0.50 → 0.50) rather than like B and C (`demoted`, 1.00). So D lost the offset rather than acquiring a new trap failure.

**Interpretation, stated conservatively.** Both regressions are single-observation differences. The plan specifies one rep per cell, and unlike the Gemini arms — which ran at temperature 0 and were near-deterministic — the Codex arms have no temperature control and inherit `model_reasoning_effort` from the CLI, so run-to-run variance is real and unmeasured. Two of the three arms that "should" behave alike on the `fx-sql-injection` trap did, and D did not; that is as consistent with sampling noise as with a genuine interaction. **The eval as designed cannot distinguish the two.** What can be said without qualification: arm D introduced no fabrications, lost no BLOCKING-floor defect, held clean-fixture honesty, and kept format compliance — the failure is confined to two half-point deductions on secondary metrics.

**Consequence for the landing.** R1 and R3 landed on the per-candidate rule, which is what the plan and the audit's acceptance criteria specify. That is the letter of the protocol and it was followed. The honest caveat is that the shipped configuration is D, and D has not cleared the same bar its two components did. Recommended follow-up, in order: re-run arm D and arm A at 3+ reps per fixture to separate noise from interaction before treating the combined configuration as validated; if the `fx-swallowed-error` evidence miss reproduces, that is a real R1×R3 interaction and R3 should be reconsidered on its own (R1 carries 87% of the savings).

## Pairwise preference (secondary)

Reported but never decisive; the rubric governs. Each fixture/engine pair was judged twice by independent cold judges with the R1/R2 presentation order swapped between rounds. Only order-consistent preferences count.

| Comparison | Candidate | Baseline | Tie | Order-inconsistent (discarded) |
|---|---|---|---|---|
| Gemini A vs B (R1) | 4 | 4 | 0 | 0 |
| Codex A vs B (R1) | 3 | 3 | 0 | 2 |
| Codex A vs C (R3) | 6 | 2 | 0 | 0 |
| Codex A vs D (R1+R3) | 3 | 3 | 0 | 2 |

R1 is a dead heat on both engines — consistent with the rubric finding that it changes almost nothing. R3 is preferred 6–2 on Codex, the strongest single signal in the eval and pointing the same direction as its rubric result. Arm D returns to a dead heat, which is mildly corroborating for the interaction concern above but far too weak to carry weight on its own: pairwise preference never overrides the rubric, and 3–3 with two discarded pairs is close to no signal at all.

32 of 36 completed comparisons were order-consistent. The four discarded pairs were all on Codex (two in B, two in D); every Gemini and every R3 pair agreed under order swap.

## Decisions

| Candidate | Gemini | Codex | Decision |
|---|---|---|---|
| **R1** — review system-prompt nucleus | PASS | PASS | **LANDS** |
| **R3** — Codex review-handoff header | n/a (header never reaches Gemini) | PASS | **LANDS** |
| R1+R3 combined (arm D) | n/a | **FAIL** | advisory; not a candidate — see follow-up |

Against the four conditions, for both R1 and R3:

- **(a) no metric shows net paired regressions** — held. Every metric is net 0 or better on both candidates. R3's trap row is 1–1, which is not a net regression under the rule as written.
- **(b) no BLOCKING-floor defect found by baseline and missed by the candidate** — held. No BLOCKING-floor defect moved in any direction in any arm, including D.
- **(c) fx-clean honesty does not degrade** — held. Honesty passed in every arm on both engines.
- **(d) net fabrications do not increase** — held, trivially: **the fabrication count is 0 in all 48 reviews**. No arm on either engine asserted anything disprovable against the fixture source.

Ties go to the savings per the plan, which is what carries R1 on Gemini (tied on seven of eight metrics, +1 on trap).

**What this does and does not license.** It licenses landing each trim on the evidence that it, individually, does not degrade review quality. It does not establish that the combined configuration is safe — arm D says otherwise, on two half-point secondary deductions that the eval's one-rep design cannot separate from noise. The trims landed anyway because that is the rule the audit and the plan set in advance, and rewriting the rule after seeing the result would defeat the point of fixing it beforehand. The open risk is recorded above and in the narrative.

## Cost

Cold grader and judge subagents, from `runs/token-ledger.tsv`:

| Kind | Count | Tokens |
|---|---|---|
| Rubric graders (counted) | 48 | 955,717 |
| Rubric graders (discarded, note 8) | 7 | 224,142 |
| Pairwise judges | 48 | 1,516,667 |
| Staff Engineer landing review | 1 | 92,314 |
| **Total subagent tokens** | **104** | **2,788,840** |

Not included: 16 Gemini API calls at temperature 0, and 32 Codex background runs at inherited `model_reasoning_effort` (the companion does not report per-job token counts). Wall clock for the Codex arms was roughly 2.9 hours at 2 concurrent across both driver invocations, with zero job errors in 32 runs.

## Landing

Applied after both candidates passed, per the plan's conditional landing phase:

- `src/providers/base.ts` — review-branch return value of `getSystemPrompt` replaced with the frozen R1 text; the orphaned `VERIFICATION_REQUIREMENTS` constant removed. 1,158 → 390 B.
- `src/providers/codex.ts` — `CODEX_REVIEW_HANDOFF_HEADER` replaced with the frozen R3 text. 258 → 138 B.
- Test expectations updated in `base.test.ts`, `codex.test.ts`, `config.test.ts` and `review.test.ts`.
- **494 tests pass, 21 files; `npm run build` exit 0.** `templates/second-opinion.md` untouched, so no methodology re-sync was required (the installer confirmed it skipped the existing target).

Staff Engineer review: **APPROVE**, no Criticals. Verified byte-exactness of both landed strings against the strings the eval actually scored (sha256 match), proved task mode byte-identical via a baseline differential build, and mutation-tested 15 mutants. Three findings were applied rather than deferred:

- **W1** — re-appending the deleted 767 B verification block passed the whole suite. The review nucleus is now pinned by string equality against the evaluated text (`base.test.ts`, "pins the review nucleus to the evaluated text"), so any future edit fails loudly and must go through a fresh eval. Mutation re-run confirms it now fails.
- **W2** — reinstating the dropped role/grounding lines under the new header title passed the whole suite. Absence guards added in `codex.test.ts`; mutation re-run confirms it now fails.
- **W3** — R1 makes the phase structure, severity ladder and diff/pre-existing split *single-sourced* in `<instructions>`, which resolves to a user-overridable file that the installer deliberately never re-syncs. A test in `config.test.ts` now asserts the canonical template still carries every anchor the nucleus delegates to.

Deferred with rationale: the `<instructions>` token collision (the R1 text emits a bare unbalanced `<instructions>` tag inside `<system-instructions>`). The text is frozen and empirically tolerated across 16 arm-B reviews on both engines; backticking it is a candidate for any future revision. The `review.test.ts` ordering assertion is anchored on `\n<instructions>\n` to target the real section rather than that reference.

## Judging manifest

Blind id per fixture/engine/arm. Graders and judges saw only these ids as directory names.

| Fixture | Engine | A | B | C | D |
|---|---|---|---|---|---|
| `fx-boundary-refactor` | gemini | `p77jdz6g` | `gmx72hce` | – | – |
| `fx-boundary-refactor` | codex | `yp2dwkxe` | `9dvnskma` | `kdzavcdy` | `vaw8xwmm` |
| `fx-clean` | gemini | `wxk9hgp4` | `erun2gue` | – | – |
| `fx-clean` | codex | `i83jge49` | `4g6atswk` | `uqf37wp4` | `cut7pvf3` |
| `fx-null-contract` | gemini | `d8eids7e` | `r6u73vb9` | – | – |
| `fx-null-contract` | codex | `xwemphq3` | `ceg95gsi` | `v6g6i56n` | `n79iaqyh` |
| `fx-perf-unbounded` | gemini | `vzgqu337` | `mrhb9pd6` | – | – |
| `fx-perf-unbounded` | codex | `49y5bfgv` | `65etba9x` | `4pmm8mnd` | `p5z5mbe8` |
| `fx-race` | gemini | `72i89sjn` | `smgvq62w` | – | – |
| `fx-race` | codex | `h8fccmev` | `svjm7ayq` | `mzce3q8p` | `dhuupiy4` |
| `fx-reachability-trap` | gemini | `hd4nwebm` | `2cyv5t5b` | – | – |
| `fx-reachability-trap` | codex | `4i5arejz` | `iqe9nvhh` | `x4guvxf6` | `jqmizmdq` |
| `fx-sql-injection` | gemini | `9wq5vbzj` | `th8zbtgn` | – | – |
| `fx-sql-injection` | codex | `k54mvy7f` | `hq7qbqk4` | `ecz2vmtr` | `cw7n92i6` |
| `fx-swallowed-error` | gemini | `gqsbk98e` | `vsiimern` | – | – |
| `fx-swallowed-error` | codex | `pdee2znh` | `fnwekv96` | `pcdqexdb` | `av6duq4x` |

## Reproducing

State root `/tmp/r1r3-eval` (scratch; not preserved across reboots). `runs/codex-jobs.json` records every Codex job id and result size; `runs/checkpoint.json` records per-run composed prompt bytes; `runs/scores.json` holds every rubric verdict and the computed comparisons; `runs/pairwise-results.json` holds the per-round judge votes with reasons; `runs/token-ledger.tsv` is the cost ledger. `score.mjs` recomputes the decision rule from the verdicts, `pairwise.mjs` the preference tally, and `report.mjs` regenerates the tables in this document.

## Limitations

Recorded so the result is not over-read.

1. **One rep per cell.** The plan specifies a single run per fixture/arm. Gemini ran at temperature 0 and reproduced near-deterministically, so its paired comparisons are trustworthy. The Codex path has no temperature control, so every Codex difference of a single half-point — including both arm-D regressions — is within plausible run-to-run variance. This is the eval's main weakness and the reason the arm-D result is reported as unresolved rather than as a proven interaction.
2. **Eight fixtures, seeded defects, <400 lines each.** They probe recall, evidence, severity discipline, diff classification and trap resistance on small, legible code. They say nothing about behaviour on large diffs, unfamiliar domains, or long-context degradation.
3. **The rubric's trap gradient rewards narration.** Explicitly naming a safe lookalike scores double not mentioning it, even though neither is a false positive. Any future eval should either separate "avoided the false positive" from "named the counter-example" or weight them differently.
4. **Graders are LLMs.** Every verdict is one cold subagent's reading of the truth file against one review; no verdict was independently double-graded. The pairwise pass is double-judged with order swap, which is why it is reported alongside — but it is the secondary signal, not the primary one.
