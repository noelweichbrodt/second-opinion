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
 * Note: This provider's review() method returns only Gemini's response
 * for interface compatibility. Use getConsensusReview() for full results.
 */
export class ConsensusProvider implements ReviewProvider {
  name = "consensus";
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async review(request: ReviewRequest): Promise<ReviewResponse> {
    const result = await getConsensusReview(request, this.config);

    // For interface compatibility, return combined review
    // The actual consensus formatting happens in the output layer
    const combinedReview = formatConsensusForProvider(result);

    return {
      review: combinedReview,
      model: `consensus (${result.gemini.model}, ${result.openai.model})`,
      tokensUsed:
        (result.gemini.tokensUsed || 0) + (result.openai.tokensUsed || 0),
    };
  }
}

/**
 * Simple formatting for provider interface compatibility.
 * Full formatting with headers is done in consensus-formatter.ts
 */
function formatConsensusForProvider(result: ConsensusResult): string {
  const parts: string[] = [];

  if (result.gemini.error) {
    parts.push(`## Gemini Error\n\n${result.gemini.error}\n`);
  } else {
    parts.push(`## Gemini's Analysis\n\n${result.gemini.review}\n`);
  }

  parts.push("---\n");

  if (result.openai.error) {
    parts.push(`## OpenAI Error\n\n${result.openai.error}\n`);
  } else {
    parts.push(`## OpenAI's Analysis\n\n${result.openai.review}\n`);
  }

  return parts.join("\n");
}
