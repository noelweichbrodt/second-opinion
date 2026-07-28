---
name: second-opinion
description: Get feedback from Gemini or Codex on your current work (0.7.0)
user-invocable: true
---

# Second Opinion Skill

Gemini runs through its API. Codex is a handoff: the MCP tool exports a complete prompt and this skill runs `/codex:rescue` (openai-codex plugin, ChatGPT-plan auth). The MCP server never calls the OpenAI API.

`/second-opinion [gemini|codex|consensus] [focus or task]` — provider defaults to `consensus` (Gemini + Codex; degrades to Codex-only without `GEMINI_API_KEY`). `openai` is a deprecated alias for `codex`.

## 1. Parse and Classify

1. First word is the provider only if it is `gemini`, `codex`, `consensus`, or `openai`; otherwise use `consensus`.
2. Parse inline `key=value` options (list below).
3. Move explicitly mentioned file paths into `includeFiles`. For paths outside the project set `allowExternalFiles: true` and confirm first: `dryRun: true`, show the user exactly what would be sent, proceed only after confirmation.
4. Classify the remaining text:
   - **Augment** (default): review focus, concerns, audits, verification requests. Pass each point via `focusAreas`; omit `task` so the full review methodology still runs.
   - **Replace** (rare): a non-review deliverable such as docs or a migration guide. Set `task`; task prompts are self-contained, without the review methodology.
   - When uncertain, augment.
5. Derive a descriptive `sessionName`; in augment mode include the focus.

Temperature is Gemini-only (consensus applies it to Gemini only). There is no Codex reasoning-effort option.

## 2. Call the Tool

Call `mcp__second-opinion__second_opinion` with `provider`, absolute `projectPath`, `sessionName`, plus `focusAreas` or `task` and requested options.

## 3. Complete Every Codex Handoff

Codex/consensus results return `handoff: true` with `promptFile`, a placeholder `reviewFile`, `egressManifestFile`, and rescue/verify/splice commands.

1. Run `rescueCommand`, preserving its model, prompt path, read-only instruction, and task text. **Never add `--effort`** — omitting it inherits `model_reasoning_effort = "ultra"` from `~/.codex/config.toml`; explicit values top out at `xhigh`.
2. Small bundle: insert `--wait` before the task text. Large bundle: insert `--background` and track with `/codex:status`.
3. Put Codex's complete final message into `reviewFile` verbatim — never summarize, edit, reformat, or omit any part:
   - Background job: run `spliceCommand` with `JOB_ID` replaced by the job id — it splices the stored output byte-for-byte. On FAIL, fall back to `/codex:result` and paste verbatim — unless it reports a handoff mismatch: use the newest handoff's spliceCommand.
   - Foreground: paste the final message verbatim over the placeholder.
4. Consensus: read the Gemini review (and Codex review, if spliced) from `reviewFile` once; write `## Synthesis` only after both reviews are present.
5. Run `verifyCommand` to confirm completion (OK/FAIL, no full-file re-read). On FAIL, repair or report — never report an incomplete handoff as done.
6. If the Codex job fails, leave the placeholder intact and report the failure. Never fabricate output or synthesize a partial consensus.

## 4. Synthesis (consensus)

Write `## Synthesis` by following the instructions embedded under its placeholder, replacing both the placeholder and the instruction block. Use your full session context, not just the two reviews.

## 5. Report

Report the review-file path, egress-manifest path, provider and model, file/token counts, and a brief findings summary — only after `verifyCommand` passes (and, for consensus, the synthesis is written).

## Inline Options

`temp`/`temperature` (Gemini, 0–1) · `maxInputTokens` · `maxOutputTokens` (Gemini) · `includeFiles` (comma-separated) · `allowExternalFiles` · `includeDeps`/`includeDependencies` · `includeTests` · `includeTypes` · `dryRun` · `focusAreas` (comma-separated). Reasoning effort is intentionally not configurable.
