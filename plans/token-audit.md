# Token-usage audit — Phase 1

Audit date: 2026-07-27
Scope: accepted, uncommitted Codex-handoff baseline; audit only
Estimator: UTF-8 bytes / 4. This is deliberately the repository's existing rough estimator, not a model-specific tokenizer (`src/utils/tokens.ts:5-13`).

Authored by the Principal Engineer (Codex gpt-5.6-sol, thread 019fa5a2-841f-7391-aff0-555d83a475a7); materialized to disk by the C-suite because the audit ran in a read-only sandbox.

## Measurement baseline

- `CLAUDE.md`: 10,845 B (~2,711 tokens); `second-opinion.skill.md`: 6,535 B (~1,634); canonical methodology: 12,255 B (~3,064).
- The actual compact `tools/list` response from `node dist/index.js` is 3,138 B; the complete JSON-RPC wire message plus newline is 3,173 B (~793 tokens). This is the wire artifact, not a source-code estimate.
- Live `second-opinions/` samples: 8 consensus reviews have a 13,011 B median (range 3,361–16,733); 4 legacy `*.openai.review.md` files, used only as size proxies for Codex-only final messages because no new `*.codex.*` review exists, have a 5,986 B median (4,279–12,424); 12 manifests have an 8,240 B median (414–10,905).
- There is no live handoff `*.prompt.md` sample. Running the current composer in memory on the current 26-file bundle measured 304,255 B of raw payload, 306,225 B after bundle formatting, and a 320,476 B Codex prompt. Thus 16,221 B (~4,055 tokens) of necessary or candidate overhead is not represented in `bundle.totalTokens`: methodology, system/handoff instructions, language hints, wrappers, and bundle envelope (`src/tools/review.ts:380-409`, `src/providers/base.ts:70-149`, `src/providers/codex.ts:29-53`).
- Projected values below are conservative targets or live-sample medians. Variable costs state their formula/sample explicitly. Totals do not add mutually exclusive review mode and replacement-task mode.

## Ranked findings

Ranking is qualitative `(savings × expected frequency) / risk`: fixed and common low-risk costs lead; rare/conditional and prompt-content changes are gated even when their ceiling is larger.

| Rank / id | Surface | Frequency | Measured current cost | Projected savings | Risk | Concrete refactor sketch |
|---|---|---|---|---|---|---|
| 1 / I1 | Non-dry-run egress detail echoed into the MCP result | per-invocation | Reconstructed with the current response shape from 12 live manifests: 215–11,350 B, median 8,744 B (~2,186 tokens). A clean 19-path/0-blocked sample is 1,381 B; large blocked-file arrays dominate other samples. The same details are persisted in the manifest (`src/tools/review.ts:228-262`, `src/server.ts:186-241`, `src/output/writer.ts:216-251`). | Replace non-dry-run `summary` arrays with provider, project/external/blocked counts, redaction/PR counts, and the already-returned manifest pointer: 132–135 B in the samples. Median saving 8,609 B (~2,152 tokens); clean-sample saving 1,247 B (~312). Keep the full paths, locations, blocked entries, and warnings unchanged in `dryRun` (`src/server.ts:162-183`). | None | Split detailed manifest/dry-run data from a lean non-dry response DTO. Never weaken the external-file preview or consent gate. |
| 2 / S1 | `CLAUDE.md` restates the invocation skill and README | per-session | 10,845 B (~2,711 tokens) loaded in every repository session. Provider semantics, parsing, examples, handoff, synthesis, options, parameters, setup, and config repeat `second-opinion.skill.md:7-140` and `README.md:58-263` (`CLAUDE.md:1-228`). | Target ≤1,200 B; save ≥9,645 B (~2,411 tokens) per session. | Low | Make it developer-only: pointers to the skill/README; test/build commands; verbatim-output invariant; exact no-`--effort` rationale; OpenAI-pattern redactor gotcha; and template re-sync warning. Remove user-facing usage/setup/config duplication. |
| 3 / H1 | Broad review-file reads, including mandatory final full re-read | per-handoff | The final reread costs the whole file: live consensus median 13,011 B (~3,253 tokens), Codex-only proxy median 5,986 B (~1,497). Before consensus synthesis, the current 28-file writer/formatter adds 2,851 B (~713) of headers, file lists, synthesis directions, handoff command, and footer beyond the reviewer text. The skill mandates the final read (`second-opinion.skill.md:75-100`); layout comes from `src/output/writer.ts:149-180` and `src/output/consensus-formatter.ts:26-110`. | A ≤200 B structural result saves ~12,811 B (~3,203) on a median consensus completion or ~5,786 B (~1,447) on Codex-only. Reading only the reviewer sections for synthesis saves at least another 2,651 B (~663) per consensus handoff. | Low | Add unique pending markers and a local verifier that reports only section/marker counts, byte count, and hash. For synthesis, read the complete Gemini and Codex reviews exactly once—no metadata, commands, placeholder prose, or post-write full-file read. If Codex is already in context, read only Gemini. |
| 4 / V1 | `MAX_CONTEXT_TOKENS` is parsed but cannot supply the tool default | per-review | `ConfigSchema` parses `maxContextTokens` (`src/config.ts:6-20,49-70`), but Zod always materializes `maxInputTokens: 200000` (`src/tools/review.ts:122-125`), and bundling uses only that value (`src/tools/review.ts:337-351`). Cost is 0 at the current 200k config; when an operator selects 50k, the current live 75,912-token bundle would still send ~25,912 tokens above that requested cap. Maximum configured overrun is `200,000 - configured cap` per call. | All operator-requested overrun; 25,912 tokens in the measured 50k example. | None | Make tool input optional and resolve `input.maxInputTokens ?? config.maxContextTokens`. Keep the 200k default in config as the single source. This changes no default behavior and honors explicit operator intent. |
| 5 / I2 | Skill prose repeats rules and examples | per-invocation | 6,535 B (~1,634 tokens) (`second-opinion.skill.md:13-140`). Parsing/provider rules, JSON examples, handoff reporting, and inline options restate one another. | Target ≤4,000 B; save ≥2,535 B (~634 tokens) per invocation. | Low | Keep every behavioral contract once: provider parsing; augment-vs-replace; explicit-file consent; all handoff/failure/verbatim rules; synthesis; completion; and never-`--effort`. Use one compact argument table and one minimal example. |
| 6 / S2 | Hand-maintained MCP JSON schema duplicates Zod and drifts | per-session | Full wire response 3,173 B (~793 tokens), of which parsed `tools/list` is 3,138 B. The manual schema is `src/server.ts:27-147`; validation/descriptions live independently at `src/tools/review.ts:65-170`. Current drift includes `customPrompt` losing its deprecated status and generated constraints such as temperature min/max not appearing on the wire. | A measured concise, Zod-derived candidate is 2,433 B on the wire (~608), saving 740 B (~185) per session. | Low | Generate `inputSchema` from `SecondOpinionInputSchema` using a direct dependency, strip converter-only metadata not required by MCP, and tighten each `.describe()` once. Snapshot the real wire result and assert schema/validator parity. |
| 7 / I3 | Consensus result returns a Gemini preview that synthesis discards | per-handoff | A 500-character review plus `...` adds 528 B (~132 tokens) to the pretty JSON result (`src/server.ts:203-213`). The full review must still be read from `reviewFile` for synthesis. | Up to 528 B (~132) per consensus handoff. | None | For consensus, return Gemini status/model/token count/error only. Retain the preview for Gemini-only completion, where it is the useful immediate result. |
| 8 / H2 | Codex final output crosses Claude context again solely to be pasted | per-handoff | Live consensus Codex/OpenAI sections have a 7,168 B median (~1,792 tokens): synthesis needs one copy, but the Edit payload is another. Codex-only final messages have a 5,986 B median, so result retrieval plus Edit costs ~11,972 B (~2,993) although Claude need not inspect either (`second-opinion.skill.md:81-88`). | After a ≤200 B status/hash response: ≥6,968 B (~1,742) on median consensus; ≥11,772 B (~2,943) on median Codex-only. | Needs-judgment | Gate a fail-closed, atomic splice helper on the plugin's stored raw output. Consensus still reads both reviews once for synthesis; Codex-only can go job-id-to-file without surfacing the body. Preserve byte-for-byte fidelity and leave the placeholder on every failure. Runtime evidence and failure modes are below. |
| 9 / R1 | Review system prompt repeats the methodology | per-review | Canonical methodology 12,255 B (~3,064) plus review system prompt 1,158 B (~290). Of the system prompt, 585 B is verification text; phase order, evidence, diff scope, and upstream/downstream rules also appear in the methodology (`src/providers/base.ts:28-61`; `templates/second-opinion.md:3-64,143-170,200-290`). | A measured 294 B system nucleus saves 864 B (~216) per reviewer while retaining role, "follow methodology," verified-only findings, quoted blocking evidence, Questions routing, and absence search. Optional methodology consolidation to ≤11,300 B would save another ≥955 B (~239), but is not recommended without evaluation. | Needs-judgment | First test only the system-prompt candidate; keep deliberate high-priority grounding reinforcement. Treat any canonical-template edit as a separate experiment and re-sync it explicitly. |
| 10 / R2 | Replacement-task mode carries the full code-review apparatus | per-review (replacement only) | A true non-review task still gets the 12,255 B methodology as reference (`src/providers/base.ts:88-115`), the 814 B task system prompt, and 419–504 B language-pitfall block (`src/providers/base.ts:141-147`, `src/tools/review.ts:390-409`). TypeScript total: 13,498 B (~3,375). The skill defines `task` as rare, non-review output (`second-opinion.skill.md:29-32`). | Target ≤800 B of task-specific role, evidence, context, and output guidance; save ≥12,698 B (~3,175) per reviewer, or ~6,349 tokens in a two-review consensus task. | Needs-judgment | In true replace mode, omit review phases, severity taxonomy, review output template, and language bug checklist. Keep full code context, no-fabrication/evidence rules, requested deliverable, and relevant upstream/downstream thinking. |
| 11 / R3 | Codex handoff header restates the outer task, system prompt, and methodology | per-review (Codex) | `CODEX_HANDOFF_HEADER` is 258 B (~65 tokens): role and grounding repeat the system/methodology, while read-only and final-message directions repeat `rescueCommand` (`src/providers/codex.ts:29-53,66-75`). | Measured 84 B header keeps `# Codex Review`, read-only, and complete-Markdown instructions; save 174 B (~44). | Needs-judgment | Retain the read-only boundary inside the self-contained prompt; remove role/grounding restatement already supplied immediately below. |
| 12 / R4 | Markdown bundle envelope contains category-redundant annotations and a redundant summary | per-review | Current live raw payload 304,255 B becomes 306,225 B: 1,970 B (~493 tokens) of envelope. Of that, 25 repeated `*Uncommitted changes*` annotations cost exactly 575 B and the bottom context summary costs 141 B (`src/context/bundler.ts:828-841,1110-1139`). | 716 B (~179) per reviewer; twice that in consensus. | Needs-judgment | Keep paths, category headings, fences, truncation warnings, omissions, and relationship-bearing session/dependency/dependent annotations. Drop per-file Git/PR annotations already stated by their category and drop the reviewer-facing count/token breakdown. |
| 13 / R5 | Conversation context is per-message-limited but globally unbounded | per-review | Each message is cut at 2,000 characters, but every message is appended (`src/context/session.ts:432-455`) before the remaining file pool is calculated (`src/context/bundler.ts:644-719`). Synthetic current formatter measurements: 10 long messages = 20,481 B (~5,120 tokens); 100 = 203,001 B (~50,750); 500 = 1,014,201 B (~253,550), already 53,550 tokens over the 200k default before any file or prompt overhead. | With a 20k-token conversation ceiling: ~30,750 tokens at 100 long messages and ~233,550 at 500. Actual saving is `max(0, conversation tokens - ceiling)`. | Needs-judgment | Add a budget-aware policy that preserves the initial request, newest turns, and requirement-changing user messages; emit omitted-message counts and a budget warning; let the user raise the cap. Do not silently replace history with an unverified generated summary. |
| 14 / D1 | `DEFAULT_PROVIDER` is dead configuration | per-session (documentation footprint); runtime parse has no token cost | Parsed at `src/config.ts:8,49-52`, but `provider` is required and normalized in `src/tools/review.ts:65-75`; the skill supplies it (`second-opinion.skill.md:24-33`). Its standalone `CLAUDE.md` row is 153 B (~38 tokens), already included in S1. README calls it advisory (`README.md:209`). | 0 incremental after S1; maintenance/config ambiguity removed. | None | Kill rather than wire. A hidden config default would compete with the explicit skill/provider consent surface. Remove schema/env example/docs/tests with a release note. |
| 15 / G1 | Embedded fallback methodology is a fourth, drifting instruction artifact | per-review (fallback only) | `loadReviewInstructions` embeds 2,459 B (~615 tokens), 9,796 B shorter than the 12,255 B canonical template and missing major current guidance (`src/config.ts:75-157`). The installer copies the canonical file only when the target is absent and otherwise skips (`scripts/install-config.js:45-65`). | No token saving; canonical fallback adds ~2,449 tokens when invoked. This is a quality guardrail required by the SOTA constraint. | Needs-judgment | Load the packaged canonical template—or generate a build-time constant—instead of maintaining prose twice. Fail visibly if neither is available. Test byte equality with `templates/second-opinion.md`. |

## Codex stored-output investigation

Verdict: the installed `openai-codex` 1.0.6 runtime does persist the exact task final message, but the storage shape is plugin implementation, not a documented stable output-file contract.

- `executeTaskRun` captures `result.finalMessage` as `rawOutput` and includes it in the persisted payload (`~/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs:461-525`).
- Every foreground and background job goes through `runTrackedJob`, which writes both `result` and `rendered` (`~/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/lib/tracked-jobs.mjs:142-180`).
- State resolves under `CLAUDE_PLUGIN_DATA/state/<workspace-slug-hash>/jobs/<job-id>.json`; the current workspace resolves there in practice. The fallback is OS temp, and only 50 jobs are retained (`~/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/lib/state.mjs:8-13,29-56,80-115,166-190`).
- The supported helper surface `result <job-id> --json` exposes the stored job (`~/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs:910-925`). Default rendered `result` appends resume metadata, so a splice must extract `storedJob.result.rawOutput`, not paste the whole rendered command output (`~/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/lib/render.mjs:390-418`).

Proposed proof of concept: a repository helper invokes `codex-companion.mjs result <job-id> --json` as a child process, validates `completed`, extracts the string `storedJob.result.rawOutput`, requires exactly one Codex placeholder, writes an adjacent temporary file, fsyncs/renames atomically, then prints only byte count and SHA-256. Use background mode to obtain an unambiguous job id; a foreground `--wait` result does not include that id in its raw-output rendering.

It must fail without changing `reviewFile` for: running/failed/pruned/missing or ambiguous job; plugin JSON-shape/version drift; empty/non-string `rawOutput`; missing or duplicate placeholder; review file changed after handoff; write/rename failure; or hash/byte mismatch. Tests must cover Unicode, Markdown fences, trailing-newline preservation, output containing HTML comments, concurrent file mutation, and every failure path. If the plugin cannot offer a versioned JSON/output-file contract and these guards cannot be made reliable, retain the current double pass.

## Verified surfaces with no proposed cut

- Cross-category file dedup is already shared and priority ordered through one `seenPaths` set across explicit, session, PR, Git, dependencies, dependents, tests, and types (`src/context/bundler.ts:730-944`). Exact-path duplicates cost 0. Preserve this; separately test canonical/symlink aliases before claiming further savings.
- Branch diff plus full changed files is deliberate, capability-bearing duplication: the diff identifies introduced lines and the full file establishes contracts/reachability (`src/context/bundler.ts:675-715`, `src/providers/base.ts:73-85`, `templates/second-opinion.md:42-47`). The live main-branch measurement had no branch diff; configured cap is 15%/20k tokens (`src/utils/tokens.ts:35-41`). Do not remove either representation.
- Review-mode language hints cost 419–504 B (~105–126 tokens) per reviewer and are high-signal, language-specific checks (`src/utils/language.ts:8-44,96-113`). Keep them in review mode; R2 removes them only from true non-review replacement tasks.
- Prompt file metadata duplication from recon is not present: `writePromptFile` writes the composed prompt verbatim (`src/output/writer.ts:114-131`). Review/manifest metadata duplication is disk-only and useful to humans/auditing (`src/output/writer.ts:137-183,212-251`). Avoiding broad reads removes its Claude-context cost without weakening artifacts.
- Dry-run then confirmed non-dry-run rebundling is accepted consent UX. Full external paths and blocked details remain mandatory in dry-run responses (`second-opinion.skill.md:73`, `src/tools/review.ts:339-377`).
- `getFileDiff` is an unused import in the bundler (`src/context/bundler.ts:10`; implementation `src/context/git.ts:79-105`), but removing it saves no LLM tokens.

## Projected totals

These totals exclude zero-saving guardrails, configured-cap overruns, conversation-history outliers, and mutually exclusive replacement-task mode.

| Frequency class | Recommended low-risk set | With gated candidate(s) | Basis |
|---|---:|---:|---|
| per-session | ~2,596 tokens saved | same | S1 + S2: 14,018 B current to ≤3,633 B |
| per-invocation, non-dry-run live median | ~2,786 tokens saved | same | I1 + I2; a clean 19-file invocation saves ~946 instead because its result arrays are smaller |
| per-handoff, Codex-only live median | ~1,447 tokens saved | ~4,390 with splice | H1; plus H2 net |
| per-handoff, consensus live median | ~3,998 tokens saved | ~5,740 with splice | H1 + I3; plus H2 net |
| per-review, standard Gemini | 0 external-prompt tokens | ~395 | R1 + R4 |
| per-review, standard Codex | 0 external-prompt tokens | ~439 | R1 + R3 + R4 |
| per-review, replacement task | 0 external-prompt tokens | ≥3,175 | R2; do not add the standard-review R1 total |
| per-review, long conversation | 0 until judged | variable; 30,750 tokens in the 100-message sample | R5 with a 20k-token ceiling |

## Recommended implementation set

### Mechanical — implement now

1. S1/S2/I2: slim `CLAUDE.md` and the skill to their measured caps; generate/tighten the MCP schema from Zod.
2. I1/I3: make non-dry-run egress responses counts-plus-manifest and remove only the consensus Gemini preview. Preserve dry-run detail byte-for-byte at the data-contract level.
3. H1: replace full completion reads with a fail-closed structural verifier and reviewer-section extraction.
4. V1/D1: honor `MAX_CONTEXT_TOKENS`; remove dead `DEFAULT_PROVIDER` rather than creating a second provider-default authority.

Acceptance criteria:

- `wc -c CLAUDE.md ≤ 1200`; `wc -c second-opinion.skill.md ≤ 4000`; a checklist test/manual fixture proves every behavior named in S1/I2 remains.
- Actual built `tools/list` wire message is ≤2,433 B including newline; generated schema carries enum/default/min/max/required semantics; a parity test fails on future Zod/wire drift.
- Dry-run still exposes every project/external path, external location, blocked file/reason, redaction, PR datum, and budget warning. Non-dry-run exposes no path arrays, and its manifest exactly preserves them.
- Consensus handoff result has no successful-review preview but retains Gemini error/model/token status; Gemini-only still has its preview.
- Completion verifier rejects either pending marker, missing/duplicate required sections, empty review bodies, and wrong provider layout; success output is ≤200 B. Consensus synthesis consumes each complete reviewer body once.
- `MAX_CONTEXT_TOKENS=50000` makes an omitted-file/budget assertion at 50k, while omitted configuration still defaults to 200k. No reasoning-effort option is added.
- Existing tests plus new contract tests pass; build artifacts are measured after build. No implementation step edits the canonical methodology.

### Needs C-suite judgment

1. H2: prototype stored-output splicing, then approve only if byte-fidelity/fail-closed acceptance tests pass and plugin-version drift is feature-detected.
2. R1/R3/R4: evaluate the 294 B review-system nucleus, 84 B Codex header, and 716 B bundle-envelope cut independently so regressions are attributable.
3. R2: evaluate a separate ≤800 B replacement-task instruction set on documentation, migration-guide, and architecture-explanation tasks.
4. R5: choose a conversation budget/preservation policy only after testing long sessions with early requirements and late corrections.
5. G1: approve canonical packaged-template fallback as a quality fix despite its fallback-only token increase. Do not combine it with prompt-tightening evaluation.

Acceptance criteria:

- Blind baseline/candidate evaluation covers correctness recall, false positives, evidence/file-line accuracy, diff-vs-pre-existing classification, defensive-finding reachability, security, architecture, no-findings honesty, and output-format compliance. No quality metric regresses; token savings alone cannot win.
- Each prompt candidate is landed and evaluated separately. Consensus multiplies per-review costs by two.
- Spliced bytes between review markers hash exactly to `rawOutput`; all enumerated failures leave the original file and placeholder intact.
- Conversation truncation emits an explicit warning and retained/omitted counts, preserves first request plus late corrections in fixtures, and remains overridable with `maxInputTokens`.
- Any edit to `templates/second-opinion.md` is explicitly re-synced because the installer skips an existing target (`scripts/install-config.js:53-59`), then verified with `cmp templates/second-opinion.md ~/.config/second-opinion/second-opinion.md`. Preserve user customizations before overwriting.
- External-file redaction, manifest generation, dry-run consent, verbatim Codex fidelity, and the intentional absence of reasoning-effort controls remain unchanged.

---

## C-suite gating decisions (2026-07-27)

Approved for Phase 2 implementation:

- **Full mechanical set**: I1, S1, H1, V1, I2, S2, I3, D1 — as specified above.
- **R2** (replacement-task slim prompt): the methodology is review-specific by definition and already documented as mere "reference material" in replace mode; a migration guide does not need a severity taxonomy. Update all docs that mention methodology-as-reference accordingly.
- **R4** (envelope cuts): the dropped per-file annotations restate their category headings, so no information is lost to the reviewer; truncation warnings, omissions, and relationship-bearing annotations stay.
- **R5** (conversation ceiling) with a **simplified deterministic policy**: default 20k-token conversation budget; always preserve the first user request and the newest messages within budget; drop middle messages with an explicit omitted-count marker plus a `budgetWarnings` entry; overridable via `maxInputTokens`/config. The audit's "requirement-changing user messages" heuristic is rejected as under-specified — no semantic classification, no generated summaries.
- **G1** (canonical packaged-template fallback): quality guardrail; SOTA constraint outranks its fallback-only token increase.
- **H2** (splice helper) as a **gated prototype**: land only if every byte-fidelity and fail-closed acceptance test passes with feature detection on the plugin state shape; otherwise keep the double pass and document why. The MCP server may embed the absolute helper path in the handoff result so the skill can invoke it in any project.

Deferred (not this cycle):

- **R1/R3** (system-prompt nucleus, Codex header trim): ~216-260 tokens per review — roughly 0.3% of a typical bundle — against a required blind quality-evaluation apparatus. The steering redundancy is deliberately kept; SOTA-first.
- **Methodology template consolidation** (the optional ≤11,300 B variant of R1): same reasoning.

> **Resolved 2026-07-27 — read the projections above as superseded for R1/R3.** The blind evaluation ran (`plans/r1-r3-blind-eval.md`, results in `plans/r1-r3-eval-results.md`) and **R1 shipped; R3 did not.** Two corrections to the numbers in this document: the evaluated R1 candidate was 390 B rather than the 294 B proposed here, so it saves 768 B rather than 864 B; and R3's 174 B is not realized at all. The "with gated candidate(s)" column therefore overstates — the per-review Codex row should read R1 + R4, not R1 + R3 + R4. Methodology-template consolidation remains deferred and unevaluated.
