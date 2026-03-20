export interface ReviewRequest {
  instructions: string;
  context: string;
  task?: string;
  focusAreas?: string[];
  customPrompt?: string;
  /** Temperature for LLM generation (0-1). Lower = more focused, higher = more creative. */
  temperature?: number;
  /** Language-specific pitfall hints to inject into the prompt (e.g., TypeScript gotchas). */
  languageHints?: string;
  /** Maximum tokens for the LLM response. */
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
 * Verification instructions appended to every system prompt to prevent hallucinated claims.
 * Always included regardless of whether files were omitted — models can fabricate issues
 * even when the relevant code is in context.
 */
const VERIFICATION_REQUIREMENTS = `

## Important: Verification Requirements

When reviewing, you MUST verify claims against the provided code:
1. Only report issues you can VERIFY in the provided code
2. For **[BLOCKING]** findings, QUOTE the specific code that demonstrates the problem
3. If you suspect an issue but cannot find confirming code, mark it as:
   "UNVERIFIED: [description] - could not locate confirming code"
   and list it under Questions, not as a confirmed finding
4. Do NOT assume code is missing or broken without evidence
5. Search the full provided context before claiming something doesn't exist`;

/**
 * Get the system prompt based on whether a custom task is provided
 */
export function getSystemPrompt(hasTask: boolean): string {
  const base = hasTask
    ? "You are a staff software engineer. Complete the requested task thoroughly and provide clear, actionable output. When relevant, consider whether changes upstream or downstream of the immediate scope would produce a better outcome."
    : "You are a staff software engineer performing a code review. "
      + "Your goal is knowledge sharing and catching real issues — not gatekeeping. "
      + "Think in phases: understand the change, assess the architecture, analyze details, "
      + "then interrogate your own findings before presenting them. "
      + "Ground every finding in specific files and lines of code. "
      + "Look beyond the immediate diff — the right fix may live upstream or downstream. "
      + "When a git diff is provided, focus your Findings section on issues introduced by the diff. "
      + "Report pre-existing issues separately under Pre-existing Issues.";

  return base + VERIFICATION_REQUIREMENTS;
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
