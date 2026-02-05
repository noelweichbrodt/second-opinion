/**
 * Formats consensus results from multiple providers into a combined markdown document.
 */

import { ConsensusResult } from "../providers/consensus.js";

export interface ConsensusFormatOptions {
  task?: string;
  sessionName?: string;
}

/**
 * Format consensus results into a readable markdown document.
 * Shows both perspectives side-by-side with clear section headers.
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

  // Overview of what was done
  lines.push("> Both Gemini and OpenAI analyzed your code independently.");
  lines.push("> Compare their perspectives below to get a well-rounded view.");
  lines.push("");

  // Status summary
  const geminiSuccess = !result.gemini.error;
  const openaiSuccess = !result.openai.error;

  if (!geminiSuccess || !openaiSuccess) {
    lines.push("## Status");
    lines.push("");
    lines.push(
      `- Gemini: ${geminiSuccess ? "✓ Success" : `✗ Error - ${result.gemini.error}`}`
    );
    lines.push(
      `- OpenAI: ${openaiSuccess ? "✓ Success" : `✗ Error - ${result.openai.error}`}`
    );
    lines.push("");
  }

  // Gemini section
  lines.push("---");
  lines.push("");
  lines.push("## Gemini's Perspective");
  lines.push("");
  lines.push(`*Model: ${result.gemini.model}*`);
  if (result.gemini.tokensUsed) {
    lines.push(`*Tokens: ${result.gemini.tokensUsed.toLocaleString()}*`);
  }
  lines.push("");

  if (result.gemini.error) {
    lines.push(`> ⚠️ Gemini encountered an error: ${result.gemini.error}`);
  } else {
    lines.push(result.gemini.review);
  }
  lines.push("");

  // OpenAI section
  lines.push("---");
  lines.push("");
  lines.push("## OpenAI's Perspective");
  lines.push("");
  lines.push(`*Model: ${result.openai.model}*`);
  if (result.openai.tokensUsed) {
    lines.push(`*Tokens: ${result.openai.tokensUsed.toLocaleString()}*`);
  }
  lines.push("");

  if (result.openai.error) {
    lines.push(`> ⚠️ OpenAI encountered an error: ${result.openai.error}`);
  } else {
    lines.push(result.openai.review);
  }
  lines.push("");

  // Footer guidance
  lines.push("---");
  lines.push("");
  lines.push("## Reading This Review");
  lines.push("");
  lines.push("Consider the following when comparing perspectives:");
  lines.push("");
  lines.push("- **Agreement**: Issues flagged by both models are likely important");
  lines.push("- **Differences**: Unique insights from one model may reveal blind spots");
  lines.push("- **Conflicting advice**: Use your judgment based on project context");
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
