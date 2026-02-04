import { Config } from "../config.js";
import { ReviewProvider } from "./base.js";
import { GeminiProvider } from "./gemini.js";
import { OpenAIProvider } from "./openai.js";

export * from "./base.js";
export * from "./gemini.js";
export * from "./openai.js";

export type ProviderName = "gemini" | "openai";

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

    case "openai":
      if (!config.openaiApiKey) {
        throw new Error("OPENAI_API_KEY is required for OpenAI provider");
      }
      return new OpenAIProvider(config.openaiApiKey, config.openaiModel);

    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}

export function getAvailableProviders(config: Config): ProviderName[] {
  const providers: ProviderName[] = [];

  if (config.geminiApiKey) {
    providers.push("gemini");
  }
  if (config.openaiApiKey) {
    providers.push("openai");
  }

  return providers;
}
