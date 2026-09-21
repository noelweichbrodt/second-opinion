/**
 * Formats the in-process Gemini result and Codex handoff into one document.
 * Claude fills the synthesis after the Codex output has been pasted into its
 * placeholder.
 */

import { CODEX_REVIEW_PLACEHOLDER } from "../providers/codex.js";
import type { ConsensusResult } from "../providers/consensus.js";

export interface ConsensusFormatOptions {
  task?: string;
  sessionName?: string;
}

/**
 * Marker Claude replaces with the synthesis once both reviews are present.
 * Single source of truth — the verifier checks for its absence.
 */
export const SYNTHESIS_PLACEHOLDER =
  "*To be synthesized by Claude Code after both reviews are present.*";

/**
 * The synthesis how-to embedded under the placeholder. Claude consumes it
 * (replaces placeholder + instructions with the synthesis); the verifier
 * subtracts it before judging whether a synthesis body is really present.
 * Single source — keep the verifier and formatter in lockstep.
 */
export const SYNTHESIS_INSTRUCTIONS = [
  "Produce a unified review merging both perspectives:",
  "",
  "### Summary",
  "Synthesize both reviewers' overall assessments. Note agreement/disagreement.",
  "",
  "### Findings",
  "Merge and deduplicate findings from both reviews.",
  "Use severity labels: **[BLOCKING]**, **[IMPORTANT]**, **[NIT]**, **[SUGGESTION]**, **[PRAISE]**.",
  "Every finding MUST include `file:line` references. For [BLOCKING], quote the code.",
  "Each Fix must name the `file:line` the edit lands at and whether that line is replaced",
  "or the code is inserted after it. You have the working tree the reviewers did not:",
  "resolve every fix anchor they gave, correct it when wrong, supply it when missing.",
  "For each finding note which reviewer(s) flagged it (both / Gemini only / Codex only).",
  "Higher confidence when both agree. When they disagree on severity, assess which is correct.",
  "Order by severity. When a diff was provided, only include diff-related issues.",
  "",
  "### Pre-existing Issues",
  "(When a diff was provided) Issues flagged by either/both reviewers NOT in the diff.",
  "Same format as Findings — severity labels, `file:line` references, quoted code for [BLOCKING].",
  "Note which reviewer(s) flagged each.",
  "Omit section if no diff or no pre-existing issues found.",
  "",
  "### Questions",
  "Unresolved questions from either review. Deduplicate, note source.",
  "",
  "### Upstream/Downstream Opportunities",
  "Merge architectural suggestions. Note confidence and source reviewer(s).",
  "",
  "### What's Done Well",
  "Merge praise with **[PRAISE]** labels.",
  "",
  "For defensive findings, judge reachability yourself from the full codebase:",
  "demote unreachable guard suggestions, stating in plain words the condition that",
  "would have to hold; when defense is warranted, prefer one type/contract or",
  "trust-boundary fix over scattered checks.",
  "",
  "Write for the change's author, per the methodology's *Writing for the Author*.",
  "Speak plainly: no jargon, mannered prose, or packed language, and no methodology",
  "terms (altitude, rung, reachability, trust boundary). One claim and at most one code",
  "reference per sentence. A passive sentence is fine when it reads more plainly.",
  "Quote the code a claim depends on. Give mechanical fixes as fenced suggestion blocks.",
  "Introduce parallel items in one sentence, then list them. Restate reviewer findings",
  "in this form rather than copying them.",
].join("\n");

/**
 * Format consensus results into a readable markdown document.
 * Includes Gemini's review in full, a placeholder for Codex's review, and a
 * synthesis placeholder that Claude Code fills after both reviews are present.
 */
export function formatConsensusOutput(
  result: ConsensusResult,
  options: ConsensusFormatOptions = {}
): string {
  const lines: string[] = [];

  // Header
  if (options.task) {
    lines.push(`# Consensus Analysis: ${options.task.substring(0, 100)}`);
  } else {
    lines.push("# Consensus Code Review");
  }
  lines.push("");

  // Synthesis placeholder — Claude replaces it and the instruction block
  // with the unified review.
  lines.push("## Synthesis");
  lines.push("");
  lines.push(SYNTHESIS_PLACEHOLDER);
  lines.push("");
  lines.push(SYNTHESIS_INSTRUCTIONS);
  lines.push("");

  // Status summary (if the in-process Gemini call failed)
  if (result.gemini.error) {
    lines.push("## Status");
    lines.push("");
    lines.push(`- Gemini: Error - ${result.gemini.error}`);
    lines.push("- Codex: Awaiting handoff");
    lines.push("");
  }

  // Gemini section
  lines.push("---");
  lines.push("");
  lines.push("## Gemini's Review");
  lines.push("");
  lines.push(`*Model: ${result.gemini.model}*`);
  if (result.gemini.tokensUsed) {
    lines.push(`*Tokens: ${result.gemini.tokensUsed.toLocaleString()}*`);
  }
  lines.push("");

  if (result.gemini.error) {
    lines.push(`> Gemini encountered an error: ${result.gemini.error}`);
  } else {
    lines.push(result.gemini.review);
  }
  lines.push("");

  // Codex section
  lines.push("---");
  lines.push("");
  lines.push("## Codex Review");
  lines.push("");
  lines.push(`*Model: ${result.codex.model}*`);
  lines.push("");
  lines.push("Run the Codex handoff command, then replace the placeholder below with its verbatim final response:");
  lines.push("");
  lines.push("```text");
  lines.push(result.codex.rescueCommand);
  lines.push("```");
  lines.push("");
  lines.push(`Prompt file: \`${result.codex.promptFile}\``);
  lines.push("");
  lines.push(CODEX_REVIEW_PLACEHOLDER);
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate the filename for a consensus review.
 */
export function getConsensusFilename(
  sessionSlug: string,
  taskSlug?: string
): string {
  if (taskSlug) {
    return `${sessionSlug}.consensus.${taskSlug}.md`;
  }
  return `${sessionSlug}.consensus.review.md`;
}
