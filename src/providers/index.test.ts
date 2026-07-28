import { describe, expect, it } from "vitest";
import { Config } from "../config.js";
import {
  createProvider,
  getAvailableProviders,
  ProviderName,
} from "./index.js";

const baseConfig = {
  geminiModel: "gemini-2.0-flash-exp",
  codexModel: "gpt-5.6-sol",
  maxContextTokens: 100000,
  maxOutputTokens: 32768,
  reviewsDir: "second-opinions",
  temperature: 0.3,
  rateLimitWindowMs: 60000,
  rateLimitMaxRequests: 10,
} as Config;

describe("createProvider", () => {
  it("creates GeminiProvider when Gemini is requested", () => {
    const provider = createProvider("gemini", {
      ...baseConfig,
      geminiApiKey: "test-gemini-key",
    });

    expect(provider.name).toBe("gemini");
  });

  it("throws when the Gemini API key is missing", () => {
    expect(() => createProvider("gemini", baseConfig)).toThrow(
      "GEMINI_API_KEY is required"
    );
  });

  it("routes Codex orchestration back to the review tool", () => {
    expect(() => createProvider("codex", baseConfig)).toThrow(
      "Codex is a handoff provider"
    );
  });

  it("routes consensus orchestration back to the review tool", () => {
    expect(() =>
      createProvider("consensus", {
        ...baseConfig,
        geminiApiKey: "test-gemini-key",
      })
    ).toThrow("Consensus combines Gemini with a Codex handoff");
  });

  it("throws for an unknown provider", () => {
    expect(() =>
      createProvider("unknown" as ProviderName, baseConfig)
    ).toThrow("Unknown provider");
  });
});

describe("getAvailableProviders", () => {
  it("always includes Codex when no API keys are configured", () => {
    expect(getAvailableProviders(baseConfig)).toEqual(["codex"]);
  });

  it("includes Gemini and consensus when Gemini is configured", () => {
    expect(
      getAvailableProviders({
        ...baseConfig,
        geminiApiKey: "test-key",
      })
    ).toEqual(["gemini", "codex", "consensus"]);
  });
});
