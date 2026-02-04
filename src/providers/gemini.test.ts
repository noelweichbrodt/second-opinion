import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReviewRequest } from "./base.js";

// Mock generateContent function - accessible for assertions
const mockGenerateContent = vi.fn();

// Mock the Google Generative AI SDK
vi.mock("@google/generative-ai", () => {
  class MockGoogleGenerativeAI {
    constructor(_apiKey: string) {}
    getGenerativeModel(_options: unknown) {
      return {
        generateContent: mockGenerateContent,
      };
    }
  }

  return {
    GoogleGenerativeAI: MockGoogleGenerativeAI,
  };
});

// Import after mocking
import { GeminiProvider } from "./gemini.js";

describe("GeminiProvider", () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GeminiProvider("test-api-key", "gemini-2.0-flash-exp");
  });

  it("has name 'gemini'", () => {
    expect(provider.name).toBe("gemini");
  });

  it("calls generateContent with correct structure", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => "Review content here",
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 200,
        },
      },
    });

    const request: ReviewRequest = {
      instructions: "Review guidelines",
      context: "# Code\n```ts\nconst x = 1;\n```",
    };

    await provider.review(request);

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    const callArgs = mockGenerateContent.mock.calls[0][0];
    expect(callArgs.contents).toBeDefined();
    expect(callArgs.contents[0].role).toBe("user");
    expect(callArgs.contents[0].parts[0].text).toContain("Review guidelines");
    expect(callArgs.contents[0].parts[0].text).toContain("# Code Context");
  });

  it("passes task to prompt when provided", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => "Task response",
        usageMetadata: null,
      },
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
      task: "Analyze security vulnerabilities",
    };

    await provider.review(request);

    const callArgs = mockGenerateContent.mock.calls[0][0];
    expect(callArgs.contents[0].parts[0].text).toContain("# Task");
    expect(callArgs.contents[0].parts[0].text).toContain("Analyze security vulnerabilities");
  });

  it("extracts response text correctly", async () => {
    const expectedReview = "This is the review content.\n\n## Summary\nLooks good!";

    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => expectedReview,
        usageMetadata: null,
      },
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
    };

    const result = await provider.review(request);

    expect(result.review).toBe(expectedReview);
  });

  it("extracts token usage when available", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => "Review",
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 500,
        },
      },
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
    };

    const result = await provider.review(request);

    expect(result.tokensUsed).toBe(1500); // 1000 + 500
  });

  it("handles missing usage metadata gracefully", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => "Review",
        usageMetadata: null,
      },
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
    };

    const result = await provider.review(request);

    expect(result.tokensUsed).toBeUndefined();
  });

  it("returns model name in response", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => "Review",
        usageMetadata: null,
      },
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
    };

    const result = await provider.review(request);

    expect(result.model).toBe("gemini-2.0-flash-exp");
  });

  it("uses custom model when specified", async () => {
    const customProvider = new GeminiProvider("key", "gemini-pro-custom");

    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => "Review",
        usageMetadata: null,
      },
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
    };

    const result = await customProvider.review(request);

    expect(result.model).toBe("gemini-pro-custom");
  });

  it("includes focus areas in prompt when provided", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => "Review",
        usageMetadata: null,
      },
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
      focusAreas: ["Security", "Performance"],
    };

    await provider.review(request);

    const callArgs = mockGenerateContent.mock.calls[0][0];
    expect(callArgs.contents[0].parts[0].text).toContain("Security");
    expect(callArgs.contents[0].parts[0].text).toContain("Performance");
  });

  it("includes custom prompt in request when provided", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => "Review",
        usageMetadata: null,
      },
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
      customPrompt: "Pay special attention to error handling",
    };

    await provider.review(request);

    const callArgs = mockGenerateContent.mock.calls[0][0];
    expect(callArgs.contents[0].parts[0].text).toContain("Pay special attention to error handling");
  });

  it("sets generation config with maxOutputTokens and temperature", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => "Review",
        usageMetadata: null,
      },
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
    };

    await provider.review(request);

    const callArgs = mockGenerateContent.mock.calls[0][0];
    expect(callArgs.generationConfig).toBeDefined();
    expect(callArgs.generationConfig.maxOutputTokens).toBe(8192);
    expect(callArgs.generationConfig.temperature).toBe(0.3);
  });
});
