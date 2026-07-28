export interface ReviewRequest {
  instructions: string;
  context: string;
  task?: string;
  focusAreas?: string[];
  customPrompt?: string;
  /** Gemini-only generation temperature (0-1); Codex handoffs ignore it. */
  temperature?: number;
  /** Language-specific pitfall hints to inject into the prompt (e.g., TypeScript gotchas). */
  languageHints?: string;
  /** Maximum Gemini response tokens; Codex handoffs ignore it. */
  maxOutputTokens?: number;
  /** Unified git diff from the feature branch (base...HEAD). */
  branchDiff?: string;
}

export interface ReviewResponse {
  review: string;
  model: string;
  tokensUsed?: number;
}

export interface ReviewProvider {
  name: string;
  review(request: ReviewRequest): Promise<ReviewResponse>;
}

/**
 * Compact system prompt for replacement tasks. Non-review deliverables do not
 * carry the review methodology, so this keeps only the essentials: role,
 * grounding/no-fabrication, and upstream/downstream thinking.
 */
const TASK_SYSTEM_PROMPT =
  "You are a staff software engineer. Complete the requested task thoroughly and provide clear, actionable output. "
  + "Ground every claim in the provided code; if something is not present in the context, say so rather than inventing it. "
  + "When relevant, consider whether changes upstream or downstream of the immediate scope would produce a better outcome.";

/**
 * Get the system prompt based on whether a custom task is provided
 */
export function getSystemPrompt(hasTask: boolean): string {
  if (hasTask) {
    return TASK_SYSTEM_PROMPT;
  }

  // The review methodology in <instructions> already carries the phase structure,
  // the diff/pre-existing split and the severity ladder. This nucleus keeps only
  // what the methodology does not state: the role, and the anti-fabrication rules.
  return (
    "You are a staff software engineer performing a code review. "
    + "Follow the review methodology in <instructions>. "
    + "Report only issues you can verify in the provided code. "
    + "Quote the code for [BLOCKING] findings. "
    + "If you suspect an issue but cannot locate confirming code, list it under Questions, "
    + "not as a confirmed finding. "
    + "Search the full provided context before claiming something doesn't exist."
  );
}

/**
 * Build the full prompt for the LLM.
 *
 * Order: content first (code-context, branch-diff), then instructions.
 * LLMs attend better to instructions when the context they apply to has already been read.
 */
export function buildReviewPrompt(request: ReviewRequest): string {
  const parts: string[] = [];

  // 1. Code context (full file contents)
  parts.push("<code-context>");
  parts.push(request.context);
  parts.push("</code-context>");
  parts.push("");

  // 2. Branch diff (when available)
  if (request.branchDiff) {
    parts.push("<branch-diff>");
    parts.push(request.branchDiff);
    parts.push("</branch-diff>");
    parts.push("");
  }

  // 3. Task or instructions
  if (request.task) {
    parts.push("<task>");
    parts.push(request.task);

    if (request.focusAreas && request.focusAreas.length > 0) {
      parts.push("");
      parts.push("## Focus Areas");
      parts.push("");
      for (const area of request.focusAreas) {
        parts.push(`- ${area}`);
      }
    }

    if (request.customPrompt) {
      parts.push("");
      parts.push("## Additional Instructions");
      parts.push("");
      parts.push(request.customPrompt);
    }
    parts.push("</task>");
    parts.push("");

    // 4. Include instructions as reference material
    if (request.instructions) {
      parts.push("<reference-instructions>");
      parts.push(request.instructions);
      parts.push("</reference-instructions>");
      parts.push("");
    }
  } else {
    // Default: code review mode
    parts.push("<instructions>");
    parts.push(request.instructions);

    if (request.focusAreas && request.focusAreas.length > 0) {
      parts.push("");
      parts.push("## Specific Focus Areas for This Review");
      parts.push("");
      for (const area of request.focusAreas) {
        parts.push(`- ${area}`);
      }
    }

    if (request.customPrompt) {
      parts.push("");
      parts.push("## Additional Instructions");
      parts.push("");
      parts.push(request.customPrompt);
    }
    parts.push("</instructions>");
    parts.push("");
  }

  // 5. Language-specific hints
  if (request.languageHints) {
    parts.push("<language-hints>");
    parts.push(request.languageHints);
    parts.push("</language-hints>");
    parts.push("");
  }

  return parts.join("\n");
}
