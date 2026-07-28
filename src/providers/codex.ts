import {
  buildReviewPrompt,
  getSystemPrompt,
} from "./base.js";
import type { ReviewRequest } from "./base.js";

/**
 * Files and command needed for Claude Code to hand a review off to Codex.
 *
 * The provider layer composes the prompt and command only. The review tool owns
 * writing these files because it also owns output naming and metadata.
 */
export interface CodexHandoff {
  promptFile: string;
  reviewFile: string;
  egressManifestFile: string;
  rescueCommand: string;
  /** Structural completion check for reviewFile; prints a ≤200 B verdict. */
  verifyCommand: string;
  /**
   * Splices a completed background Codex job's stored final message verbatim
   * over the reviewFile placeholder without routing it through Claude's
   * context. The literal JOB_ID token must be replaced with the
   * /codex:rescue job id (the token is metacharacter-free by design).
   */
  spliceCommand: string;
  model: string;
}

/**
 * Marker that the review tool writes into review files and Claude Code later
 * replaces with Codex's verbatim output. Single source of truth — the writer
 * and the consensus formatter must emit the identical marker.
 */
export const CODEX_REVIEW_PLACEHOLDER =
  "<!-- Paste the verbatim /codex:rescue output below this line -->";

// The role and the grounding rule are already stated by the system prompt spliced
// in directly below this header, so the header carries only what that prompt does
// not: the read-only boundary and the shape of the final message.
const CODEX_REVIEW_HANDOFF_HEADER = `# Codex Review Handoff

- This is a read-only task. Do not modify any files.
- Produce the complete review markdown as your final message.`;

/**
 * Replacement tasks get task framing: the review header would instruct Codex
 * to produce a review, contradicting the requested deliverable now that task
 * prompts no longer carry the review methodology.
 */
const CODEX_TASK_HANDOFF_HEADER = `# Codex External Task Handoff

You are Codex completing the task specified below.

- Ground your output in the provided \`<code-context>\` bundle.
- This is a read-only task. Do not modify any files.
- Produce the complete deliverable markdown as your final message.`;

/**
 * Compose the system and review prompts into one self-contained document for
 * the Codex CLI handoff.
 */
export function composeCodexPrompt(request: ReviewRequest): string {
  const hasTask = Boolean(request.task);
  const systemPrompt = getSystemPrompt(hasTask);
  const reviewPrompt = buildReviewPrompt(request);

  return [
    hasTask ? CODEX_TASK_HANDOFF_HEADER : CODEX_REVIEW_HANDOFF_HEADER,
    "",
    "<system-instructions>",
    systemPrompt,
    "</system-instructions>",
    "",
    reviewPrompt,
  ].join("\n");
}

/**
 * Build the Claude Code slash command that starts the Codex handoff.
 *
 * Deliberately do not add `--effort`: omitting it lets the Codex CLI inherit
 * the maximum reasoning effort configured by the operator.
 *
 * The command text is later embedded in an LLM-authored shell invocation, so
 * it must stay free of shell metacharacters (no backticks or quotes around
 * the path — bash command substitution would silently delete it).
 *
 * The framing mirrors the handoff header: replacement tasks must not be
 * instructed to produce a review.
 */
export function createCodexRescueCommand(
  promptFile: string,
  model: string,
  hasTask = false
): string {
  const framing = hasTask
    ? `Read the complete task prompt at ${promptFile}. ` +
      "Follow every instruction in it. Produce the complete deliverable markdown as your final message. "
    : `Read the complete review prompt at ${promptFile}. ` +
      "Follow every instruction in it. Produce the full review markdown as your final message. ";
  return (
    `/codex:rescue --model ${model} --fresh ` +
    framing +
    "This is a read-only task; modify no files."
  );
}
