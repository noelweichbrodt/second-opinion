import type { Config } from "../config.js";
import type { ReviewProvider } from "./base.js";
import { GeminiProvider } from "./gemini.js";

export * from "./base.js";
export * from "./gemini.js";
export * from "./codex.js";
export * from "./consensus.js";

export type ProviderName = "gemini" | "codex" | "consensus";

export function createProvider(
  name: ProviderName,
  config: Config
): ReviewProvider {
  switch (name) {
    case "gemini":
      if (!config.geminiApiKey) {
        throw new Error("GEMINI_API_KEY is required for Gemini provider");
      }
      return new GeminiProvider(config.geminiApiKey, config.geminiModel);

    case "codex":
      throw new Error(
        "Codex is a handoff provider and must be orchestrated by executeReview"
      );
    case "consensus":
      throw new Error(
        "Consensus combines Gemini with a Codex handoff and must be orchestrated by executeReview"
      );

    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}

export function getAvailableProviders(config: Config): ProviderName[] {
  const providers: ProviderName[] = [];

  if (config.geminiApiKey) {
    providers.push("gemini");
  }

  // Codex is a local CLI handoff and therefore needs no API key.
  providers.push("codex");

  if (config.geminiApiKey) {
    providers.push("consensus");
  }

  return providers;
}
