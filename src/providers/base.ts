export interface ReviewRequest {
  instructions: string;
  context: string;
  task?: string;
  focusAreas?: string[];
  customPrompt?: string;
  /** Temperature for LLM generation (0-1). Lower = more focused, higher = more creative. */
  temperature?: number;
  /** Whether files were omitted from context due to budget constraints */
  hasOmittedFiles?: boolean;
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
 * Calibration text for when files were omitted due to budget constraints
 */
const CONTEXT_CALIBRATION = `

## Important: Context Limitations

This review is based on a subset of the codebase. Some files were omitted due to token limits.

When reviewing:
1. Only report issues you can VERIFY in the provided code
2. If you suspect an issue but cannot see the relevant implementation, mark it as:
   "⚠️ UNVERIFIED: [description] - relevant code not in context"
3. Do NOT assume missing code is actually missing from the codebase
4. Check the "Omitted Files" section before flagging missing implementations`;

/**
 * Get the system prompt based on whether a custom task is provided
 * and whether files were omitted from context
 */
export function getSystemPrompt(hasTask: boolean, hasOmittedFiles?: boolean): string {
  let prompt = hasTask
    ? "You are a senior software engineer. Complete the requested task thoroughly and provide clear, actionable output. When relevant, consider whether changes upstream or downstream of the immediate scope would produce a better outcome."
    : "You are a senior software engineer performing a code review. You have seen systems like this evolve over years. Be thorough, constructive, and actionable. Look beyond the immediate diff — consider whether the right change might be above or below the code under review.";

  // Add calibration when files were omitted
  if (hasOmittedFiles) {
    prompt += CONTEXT_CALIBRATION;
  }

  return prompt;
}

/**
 * Build the full prompt for the LLM
 */
export function buildReviewPrompt(request: ReviewRequest): string {
  const parts: string[] = [];

  // When a task is provided, it becomes the primary objective
  if (request.task) {
    parts.push("# Task");
    parts.push("");
    parts.push(request.task);
    parts.push("");

    // Focus areas if specified
    if (request.focusAreas && request.focusAreas.length > 0) {
      parts.push("## Focus Areas");
      parts.push("");
      for (const area of request.focusAreas) {
        parts.push(`- ${area}`);
      }
      parts.push("");
    }

    // Additional instructions if specified
    if (request.customPrompt) {
      parts.push("## Additional Instructions");
      parts.push("");
      parts.push(request.customPrompt);
      parts.push("");
    }

    // Include instructions as reference material
    if (request.instructions) {
      parts.push("---");
      parts.push("");
      parts.push("## Reference Instructions");
      parts.push("");
      parts.push(
        "*Use the following instructions as reference where relevant to your task:*"
      );
      parts.push("");
      parts.push(request.instructions);
      parts.push("");
    }
  } else {
    // Default: code review mode
    parts.push(request.instructions);
    parts.push("");

    // Focus areas if specified
    if (request.focusAreas && request.focusAreas.length > 0) {
      parts.push("## Specific Focus Areas for This Review");
      parts.push("");
      for (const area of request.focusAreas) {
        parts.push(`- ${area}`);
      }
      parts.push("");
    }

    // Custom prompt if specified (legacy support)
    if (request.customPrompt) {
      parts.push("## Additional Instructions");
      parts.push("");
      parts.push(request.customPrompt);
      parts.push("");
    }
  }

  // Separator
  parts.push("---");
  parts.push("");
  parts.push("# Code Context");
  parts.push("");

  // The actual context
  parts.push(request.context);

  return parts.join("\n");
}
