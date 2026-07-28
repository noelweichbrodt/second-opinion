import type { Config } from "../config.js";
import type { ReviewRequest, ReviewResponse } from "./base.js";
import type { CodexHandoff } from "./codex.js";
import { GeminiProvider } from "./gemini.js";

export interface ConsensusResult {
  gemini: ReviewResponse & { error?: string };
  codex: CodexHandoff;
}

/**
 * Get the Gemini half of a consensus review and pair it with the Codex
 * handoff assembled by the review tool.
 */
export async function getConsensusReview(
  request: ReviewRequest,
  config: Config,
  codex: CodexHandoff
): Promise<ConsensusResult> {
  if (!config.geminiApiKey) {
    throw new Error(
      "Consensus mode requires GEMINI_API_KEY to be configured"
    );
  }

  const geminiProvider = new GeminiProvider(
    config.geminiApiKey,
    config.geminiModel
  );

  let gemini: ReviewResponse & { error?: string };
  try {
    gemini = await geminiProvider.review(request);
  } catch (error) {
    gemini = {
      review: "",
      model: config.geminiModel,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return { gemini, codex };
}

/**
 * Consensus needs Gemini credentials; Codex is always available as a handoff.
 */
export function isConsensusAvailable(config: Config): boolean {
  return Boolean(config.geminiApiKey);
}
