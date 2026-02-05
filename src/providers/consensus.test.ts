import { describe, it, expect, vi, beforeEach } from "vitest";
import { Config } from "../config.js";
import { ReviewRequest } from "./base.js";

// Mock the provider implementations
const mockGeminiReview = vi.fn();
const mockOpenAIReview = vi.fn();

vi.mock("./gemini.js", () => ({
  GeminiProvider: class MockGeminiProvider {
    name = "gemini";
    review = mockGeminiReview;
    constructor(_apiKey: string, _model: string) {}
  },
}));

vi.mock("./openai.js", () => ({
  OpenAIProvider: class MockOpenAIProvider {
    name = "openai";
    review = mockOpenAIReview;
    constructor(_apiKey: string, _model: string) {}
  },
}));

// Import after mocking
import {
  getConsensusReview,
  isConsensusAvailable,
  ConsensusProvider,
} from "./consensus.js";

describe("getConsensusReview", () => {
  const baseConfig: Config = {
    geminiApiKey: "test-gemini-key",
    openaiApiKey: "test-openai-key",
    defaultProvider: "gemini",
    geminiModel: "gemini-2.0-flash-exp",
    openaiModel: "gpt-4o",
    maxContextTokens: 100000,
    reviewsDir: "second-opinions",
  };

  const baseRequest: ReviewRequest = {
    instructions: "Review guidelines",
    context: "# Code\nconst x = 1;",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls both providers in parallel", async () => {
    mockGeminiReview.mockResolvedValue({
      review: "Gemini review",
      model: "gemini-2.0-flash-exp",
      tokensUsed: 100,
    });
    mockOpenAIReview.mockResolvedValue({
      review: "OpenAI review",
      model: "gpt-4o",
      tokensUsed: 150,
    });

    const result = await getConsensusReview(baseRequest, baseConfig);

    expect(mockGeminiReview).toHaveBeenCalled();
    expect(mockOpenAIReview).toHaveBeenCalled();
    expect(result.gemini.review).toBe("Gemini review");
    expect(result.openai.review).toBe("OpenAI review");
  });

  it("returns both results when both succeed", async () => {
    mockGeminiReview.mockResolvedValue({
      review: "Looks good from Gemini",
      model: "gemini-2.0-flash-exp",
      tokensUsed: 500,
    });
    mockOpenAIReview.mockResolvedValue({
      review: "Looks good from OpenAI",
      model: "gpt-4o",
      tokensUsed: 600,
    });

    const result = await getConsensusReview(baseRequest, baseConfig);

    expect(result.gemini.review).toBe("Looks good from Gemini");
    expect(result.gemini.tokensUsed).toBe(500);
    expect(result.gemini.error).toBeUndefined();

    expect(result.openai.review).toBe("Looks good from OpenAI");
    expect(result.openai.tokensUsed).toBe(600);
    expect(result.openai.error).toBeUndefined();
  });

  it("throws if Gemini API key is missing", async () => {
    const configWithoutGemini = {
      ...baseConfig,
      geminiApiKey: undefined,
    };

    await expect(
      getConsensusReview(baseRequest, configWithoutGemini as Config)
    ).rejects.toThrow("GEMINI_API_KEY");
  });

  it("throws if OpenAI API key is missing", async () => {
    const configWithoutOpenAI = {
      ...baseConfig,
      openaiApiKey: undefined,
    };

    await expect(
      getConsensusReview(baseRequest, configWithoutOpenAI as Config)
    ).rejects.toThrow("OPENAI_API_KEY");
  });

  it("handles Gemini failure gracefully", async () => {
    mockGeminiReview.mockRejectedValue(new Error("Gemini API error"));
    mockOpenAIReview.mockResolvedValue({
      review: "OpenAI review works",
      model: "gpt-4o",
      tokensUsed: 200,
    });

    const result = await getConsensusReview(baseRequest, baseConfig);

    expect(result.gemini.error).toBe("Gemini API error");
    expect(result.gemini.review).toBe("");
    expect(result.openai.review).toBe("OpenAI review works");
    expect(result.openai.error).toBeUndefined();
  });

  it("handles OpenAI failure gracefully", async () => {
    mockGeminiReview.mockResolvedValue({
      review: "Gemini review works",
      model: "gemini-2.0-flash-exp",
      tokensUsed: 200,
    });
    mockOpenAIReview.mockRejectedValue(new Error("OpenAI rate limited"));

    const result = await getConsensusReview(baseRequest, baseConfig);

    expect(result.gemini.review).toBe("Gemini review works");
    expect(result.gemini.error).toBeUndefined();
    expect(result.openai.error).toBe("OpenAI rate limited");
    expect(result.openai.review).toBe("");
  });

  it("handles both providers failing", async () => {
    mockGeminiReview.mockRejectedValue(new Error("Gemini down"));
    mockOpenAIReview.mockRejectedValue(new Error("OpenAI down"));

    const result = await getConsensusReview(baseRequest, baseConfig);

    expect(result.gemini.error).toBe("Gemini down");
    expect(result.openai.error).toBe("OpenAI down");
  });

  it("passes temperature to both providers", async () => {
    mockGeminiReview.mockResolvedValue({
      review: "Review",
      model: "gemini-2.0-flash-exp",
    });
    mockOpenAIReview.mockResolvedValue({
      review: "Review",
      model: "gpt-4o",
    });

    const requestWithTemp: ReviewRequest = {
      ...baseRequest,
      temperature: 0.7,
    };

    await getConsensusReview(requestWithTemp, baseConfig);

    expect(mockGeminiReview).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.7 })
    );
    expect(mockOpenAIReview).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.7 })
    );
  });
});

describe("isConsensusAvailable", () => {
  it("returns true when both API keys are configured", () => {
    const config: Config = {
      geminiApiKey: "key1",
      openaiApiKey: "key2",
      defaultProvider: "gemini",
      geminiModel: "gemini-2.0-flash-exp",
      openaiModel: "gpt-4o",
      maxContextTokens: 100000,
      reviewsDir: "second-opinions",
    };

    expect(isConsensusAvailable(config)).toBe(true);
  });

  it("returns false when Gemini key is missing", () => {
    const config: Config = {
      geminiApiKey: undefined,
      openaiApiKey: "key2",
      defaultProvider: "gemini",
      geminiModel: "gemini-2.0-flash-exp",
      openaiModel: "gpt-4o",
      maxContextTokens: 100000,
      reviewsDir: "second-opinions",
    };

    expect(isConsensusAvailable(config)).toBe(false);
  });

  it("returns false when OpenAI key is missing", () => {
    const config: Config = {
      geminiApiKey: "key1",
      openaiApiKey: undefined,
      defaultProvider: "gemini",
      geminiModel: "gemini-2.0-flash-exp",
      openaiModel: "gpt-4o",
      maxContextTokens: 100000,
      reviewsDir: "second-opinions",
    };

    expect(isConsensusAvailable(config)).toBe(false);
  });

  it("returns false when both keys are missing", () => {
    const config: Config = {
      geminiApiKey: undefined,
      openaiApiKey: undefined,
      defaultProvider: "gemini",
      geminiModel: "gemini-2.0-flash-exp",
      openaiModel: "gpt-4o",
      maxContextTokens: 100000,
      reviewsDir: "second-opinions",
    };

    expect(isConsensusAvailable(config)).toBe(false);
  });
});

describe("ConsensusProvider", () => {
  const baseConfig: Config = {
    geminiApiKey: "test-gemini-key",
    openaiApiKey: "test-openai-key",
    defaultProvider: "gemini",
    geminiModel: "gemini-2.0-flash-exp",
    openaiModel: "gpt-4o",
    maxContextTokens: 100000,
    reviewsDir: "second-opinions",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has name 'consensus'", () => {
    const provider = new ConsensusProvider(baseConfig);
    expect(provider.name).toBe("consensus");
  });

  it("returns combined review from both providers", async () => {
    mockGeminiReview.mockResolvedValue({
      review: "Gemini says: looks good",
      model: "gemini-2.0-flash-exp",
      tokensUsed: 100,
    });
    mockOpenAIReview.mockResolvedValue({
      review: "OpenAI says: also good",
      model: "gpt-4o",
      tokensUsed: 150,
    });

    const provider = new ConsensusProvider(baseConfig);
    const result = await provider.review({
      instructions: "Review",
      context: "Code",
    });

    expect(result.review).toContain("Gemini");
    expect(result.review).toContain("OpenAI");
    expect(result.model).toContain("consensus");
    expect(result.tokensUsed).toBe(250); // 100 + 150
  });

  it("includes error messages in combined review", async () => {
    mockGeminiReview.mockRejectedValue(new Error("Gemini failed"));
    mockOpenAIReview.mockResolvedValue({
      review: "OpenAI review",
      model: "gpt-4o",
      tokensUsed: 100,
    });

    const provider = new ConsensusProvider(baseConfig);
    const result = await provider.review({
      instructions: "Review",
      context: "Code",
    });

    expect(result.review).toContain("Gemini");
    expect(result.review).toContain("Error");
    expect(result.review).toContain("OpenAI");
  });
});
