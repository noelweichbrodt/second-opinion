/**
 * Formats consensus results from multiple providers into a combined markdown document.
 * Both individual reviews are included in full, with a synthesis placeholder at the top
 * for Claude to fill in using its full session context.
 */

import { ConsensusResult } from "../providers/consensus.js";

export interface ConsensusFormatOptions {
  task?: string;
  sessionName?: string;
}

/**
 * Format consensus results into a readable markdown document.
 * Includes both reviews in full with a synthesis section placeholder
 * that Claude Code fills in after reading both reviews.
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

  // Synthesis placeholder — Claude fills this in using the unified review framework
  lines.push("## Synthesis");
  lines.push("");
  lines.push("*To be synthesized by Claude Code after reading both reviews.*");
  lines.push("");
  lines.push("Produce a unified review merging both perspectives:");
  lines.push("");
  lines.push("### Summary");
  lines.push("Synthesize both reviewers' overall assessments. Note agreement/disagreement.");
  lines.push("");
  lines.push("### Findings");
  lines.push("Merge and deduplicate findings from both reviews.");
  lines.push("Use severity labels: **[BLOCKING]**, **[IMPORTANT]**, **[NIT]**, **[SUGGESTION]**, **[PRAISE]**.");
  lines.push("Every finding MUST include `file:line` references. For [BLOCKING], quote the code.");
  lines.push("For each finding note which reviewer(s) flagged it (both / Gemini only / OpenAI only).");
  lines.push("Higher confidence when both agree. When they disagree on severity, assess which is correct.");
  lines.push("Order by severity. When a diff was provided, only include diff-related issues.");
  lines.push("");
  lines.push("### Pre-existing Issues");
  lines.push("(When a diff was provided) Issues flagged by either/both reviewers NOT in the diff.");
  lines.push("Same format as Findings — severity labels, `file:line` references, quoted code for [BLOCKING].");
  lines.push("Note which reviewer(s) flagged each.");
  lines.push("Omit section if no diff or no pre-existing issues found.");
  lines.push("");
  lines.push("### Questions");
  lines.push("Unresolved questions from either review. Deduplicate, note source.");
  lines.push("");
  lines.push("### Upstream/Downstream Opportunities");
  lines.push("Merge architectural suggestions. Note confidence and source reviewer(s).");
  lines.push("");
  lines.push("### What's Done Well");
  lines.push("Merge praise with **[PRAISE]** labels.");
  lines.push("");

  // Status summary (if errors)
  const geminiSuccess = !result.gemini.error;
  const openaiSuccess = !result.openai.error;

  if (!geminiSuccess || !openaiSuccess) {
    lines.push("## Status");
    lines.push("");
    lines.push(
      `- Gemini: ${geminiSuccess ? "Success" : `Error - ${result.gemini.error}`}`
    );
    lines.push(
      `- OpenAI: ${openaiSuccess ? "Success" : `Error - ${result.openai.error}`}`
    );
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

  // OpenAI section
  lines.push("---");
  lines.push("");
  lines.push("## OpenAI's Review");
  lines.push("");
  lines.push(`*Model: ${result.openai.model}*`);
  if (result.openai.tokensUsed) {
    lines.push(`*Tokens: ${result.openai.tokensUsed.toLocaleString()}*`);
  }
  lines.push("");

  if (result.openai.error) {
    lines.push(`> OpenAI encountered an error: ${result.openai.error}`);
  } else {
    lines.push(result.openai.review);
  }
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
