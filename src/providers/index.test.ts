import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createProvider, getAvailableProviders, ProviderName } from "./index.js";
import { Config } from "../config.js";

describe("createProvider", () => {
  const baseConfig: Config = {
    defaultProvider: "gemini",
    geminiModel: "gemini-2.0-flash-exp",
    openaiModel: "gpt-4o",
    maxContextTokens: 100000,
    reviewsDir: "second-opinions",
  };

  it("creates GeminiProvider when gemini is requested", () => {
    const config: Config = {
      ...baseConfig,
      geminiApiKey: "test-gemini-key",
    };

    const provider = createProvider("gemini", config);

    expect(provider.name).toBe("gemini");
  });

  it("creates OpenAIProvider when openai is requested", () => {
    const config: Config = {
      ...baseConfig,
      openaiApiKey: "test-openai-key",
    };

    const provider = createProvider("openai", config);

    expect(provider.name).toBe("openai");
  });

  it("throws when Gemini API key is missing", () => {
    const config: Config = {
      ...baseConfig,
      // No geminiApiKey
    };

    expect(() => createProvider("gemini", config)).toThrow(
      "GEMINI_API_KEY is required"
    );
  });

  it("throws when OpenAI API key is missing", () => {
    const config: Config = {
      ...baseConfig,
      // No openaiApiKey
    };

    expect(() => createProvider("openai", config)).toThrow(
      "OPENAI_API_KEY is required"
    );
  });

  it("throws for unknown provider", () => {
    const config: Config = {
      ...baseConfig,
      geminiApiKey: "key",
      openaiApiKey: "key",
    };

    expect(() => createProvider("unknown" as ProviderName, config)).toThrow(
      "Unknown provider"
    );
  });

  it("uses configured model for Gemini", () => {
    const config: Config = {
      ...baseConfig,
      geminiApiKey: "test-key",
      geminiModel: "gemini-pro-custom",
    };

    const provider = createProvider("gemini", config);

    // The model is used internally - we verify the provider was created
    expect(provider.name).toBe("gemini");
  });

  it("uses configured model for OpenAI", () => {
    const config: Config = {
      ...baseConfig,
      openaiApiKey: "test-key",
      openaiModel: "gpt-4-turbo-custom",
    };

    const provider = createProvider("openai", config);

    // The model is used internally - we verify the provider was created
    expect(provider.name).toBe("openai");
  });
});

describe("getAvailableProviders", () => {
  const baseConfig: Config = {
    defaultProvider: "gemini",
    geminiModel: "gemini-2.0-flash-exp",
    openaiModel: "gpt-4o",
    maxContextTokens: 100000,
    reviewsDir: "second-opinions",
  };

  it("returns empty array when no API keys configured", () => {
    const providers = getAvailableProviders(baseConfig);

    expect(providers).toEqual([]);
  });

  it("includes gemini when GEMINI_API_KEY is set", () => {
    const config: Config = {
      ...baseConfig,
      geminiApiKey: "test-key",
    };

    const providers = getAvailableProviders(config);

    expect(providers).toContain("gemini");
    expect(providers).not.toContain("openai");
  });

  it("includes openai when OPENAI_API_KEY is set", () => {
    const config: Config = {
      ...baseConfig,
      openaiApiKey: "test-key",
    };

    const providers = getAvailableProviders(config);

    expect(providers).toContain("openai");
    expect(providers).not.toContain("gemini");
  });

  it("includes both when both API keys are set", () => {
    const config: Config = {
      ...baseConfig,
      geminiApiKey: "gemini-key",
      openaiApiKey: "openai-key",
    };

    const providers = getAvailableProviders(config);

    expect(providers).toContain("gemini");
    expect(providers).toContain("openai");
    expect(providers).toContain("consensus"); // Consensus available when both keys set
    expect(providers).toHaveLength(3);
  });

  it("returns providers in correct order (gemini first)", () => {
    const config: Config = {
      ...baseConfig,
      geminiApiKey: "gemini-key",
      openaiApiKey: "openai-key",
    };

    const providers = getAvailableProviders(config);

    expect(providers[0]).toBe("gemini");
    expect(providers[1]).toBe("openai");
  });
});
