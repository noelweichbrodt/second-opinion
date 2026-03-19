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

  // Synthesis placeholder — Claude fills this in with full session context
  lines.push("## Synthesis");
  lines.push("");
  lines.push("*To be synthesized by Claude Code with full session context.*");
  lines.push("");
  lines.push("After reading both reviews below, this section should cover:");
  lines.push("");
  lines.push("- **Agreements**: Issues both reviewers flagged (highest confidence)");
  lines.push(
    "- **Unique Insights**: Points only one reviewer caught"
  );
  lines.push(
    "- **Disagreements**: Where they conflict, with assessment of which is correct"
  );
  lines.push(
    "- **Prioritized Action List**: Merged recommendations ordered by impact"
  );
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
