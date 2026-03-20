/**
 * Consensus provider that calls both Gemini and OpenAI in parallel.
 * Returns combined results from both providers.
 */

import { Config } from "../config.js";
import {
  ReviewProvider,
  ReviewRequest,
  ReviewResponse,
} from "./base.js";
import { GeminiProvider } from "./gemini.js";
import { OpenAIProvider } from "./openai.js";
import { formatConsensusOutput } from "../output/consensus-formatter.js";

export interface ConsensusResult {
  gemini: ReviewResponse & { error?: string };
  openai: ReviewResponse & { error?: string };
}

/**
 * Get reviews from both Gemini and OpenAI in parallel.
 * Requires both API keys to be configured.
 */
export async function getConsensusReview(
  request: ReviewRequest,
  config: Config
): Promise<ConsensusResult> {
  // Validate both API keys are present
  if (!config.geminiApiKey) {
    throw new Error(
      "Consensus mode requires GEMINI_API_KEY to be configured"
    );
  }
  if (!config.openaiApiKey) {
    throw new Error(
      "Consensus mode requires OPENAI_API_KEY to be configured"
    );
  }

  const geminiProvider = new GeminiProvider(
    config.geminiApiKey,
    config.geminiModel
  );
  const openaiProvider = new OpenAIProvider(
    config.openaiApiKey,
    config.openaiModel
  );

  // Call both providers in parallel, catching individual errors
  const [geminiResult, openaiResult] = await Promise.allSettled([
    geminiProvider.review(request),
    openaiProvider.review(request),
  ]);

  // Convert settled results to response format
  const gemini: ReviewResponse & { error?: string } =
    geminiResult.status === "fulfilled"
      ? geminiResult.value
      : {
          review: "",
          model: config.geminiModel,
          error:
            geminiResult.reason instanceof Error
              ? geminiResult.reason.message
              : String(geminiResult.reason),
        };

  const openai: ReviewResponse & { error?: string } =
    openaiResult.status === "fulfilled"
      ? openaiResult.value
      : {
          review: "",
          model: config.openaiModel,
          error:
            openaiResult.reason instanceof Error
              ? openaiResult.reason.message
              : String(openaiResult.reason),
        };

  return { gemini, openai };
}

/**
 * Check if consensus mode is available (both API keys configured).
 */
export function isConsensusAvailable(config: Config): boolean {
  return Boolean(config.geminiApiKey && config.openaiApiKey);
}

/**
 * Consensus provider implementation that wraps both providers.
 * Uses formatConsensusOutput for the full unified review framework.
 */
export class ConsensusProvider implements ReviewProvider {
  name = "consensus";
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async review(request: ReviewRequest): Promise<ReviewResponse> {
    const result = await getConsensusReview(request, this.config);

    const combinedReview = formatConsensusOutput(result, {
      task: request.task,
    });

    return {
      review: combinedReview,
      model: `consensus (${result.gemini.model}, ${result.openai.model})`,
      tokensUsed:
        (result.gemini.tokensUsed || 0) + (result.openai.tokensUsed || 0),
    };
  }
}
