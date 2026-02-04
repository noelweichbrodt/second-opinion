export interface ReviewRequest {
  instructions: string;
  context: string;
  task?: string;
  focusAreas?: string[];
  customPrompt?: string;
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
