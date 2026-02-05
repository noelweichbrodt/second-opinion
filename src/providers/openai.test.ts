import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReviewRequest } from "./base.js";

// Mock create function - accessible for assertions
const mockCreate = vi.fn();

// Mock the OpenAI SDK
vi.mock("openai", () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: mockCreate,
      },
    };
    constructor(_options: unknown) {}
  }

  return {
    default: MockOpenAI,
  };
});

// Import after mocking
import { OpenAIProvider } from "./openai.js";

describe("OpenAIProvider", () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OpenAIProvider("test-api-key", "gpt-4o");
  });

  it("has name 'openai'", () => {
    expect(provider.name).toBe("openai");
  });

  it("calls chat.completions.create with correct structure", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Review content here" } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 200,
      },
    });

    const request: ReviewRequest = {
      instructions: "Review guidelines",
      context: "# Code\n```ts\nconst x = 1;\n```",
    };

    await provider.review(request);

    expect(mockCreate).toHaveBeenCalledTimes(1);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe("gpt-4o");
    expect(callArgs.messages).toBeDefined();
    expect(callArgs.messages).toHaveLength(2);
    expect(callArgs.messages[0].role).toBe("system");
    expect(callArgs.messages[1].role).toBe("user");
  });

  it("includes system prompt for code review", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Review" } }],
      usage: null,
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
    };

    await provider.review(request);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages[0].content).toContain("code review");
    expect(callArgs.messages[0].content).toContain("constructive");
  });

  it("includes task-specific system prompt when task provided", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Task response" } }],
      usage: null,
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
      task: "Analyze security vulnerabilities",
    };

    await provider.review(request);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages[0].content).toContain("Complete the requested task");
  });

  it("passes task to user message when provided", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Task response" } }],
      usage: null,
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
      task: "Analyze security vulnerabilities",
    };

    await provider.review(request);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages[1].content).toContain("# Task");
    expect(callArgs.messages[1].content).toContain("Analyze security vulnerabilities");
  });

  it("extracts response text correctly", async () => {
    const expectedReview = "This is the review content.\n\n## Summary\nLooks good!";

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: expectedReview } }],
      usage: null,
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
    };

    const result = await provider.review(request);

    expect(result.review).toBe(expectedReview);
  });

  it("extracts token usage when available", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Review" } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 500,
      },
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
    };

    const result = await provider.review(request);

    expect(result.tokensUsed).toBe(1500); // 1000 + 500
  });

  it("handles missing usage data gracefully", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Review" } }],
      usage: null,
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
    };

    const result = await provider.review(request);

    expect(result.tokensUsed).toBeUndefined();
  });

  it("handles empty choices gracefully", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [],
      usage: null,
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
    };

    const result = await provider.review(request);

    expect(result.review).toBe("");
  });

  it("handles null message content", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: null } }],
      usage: null,
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
    };

    const result = await provider.review(request);

    expect(result.review).toBe("");
  });

  it("returns model name in response", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Review" } }],
      usage: null,
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
    };

    const result = await provider.review(request);

    expect(result.model).toBe("gpt-4o");
  });

  it("uses custom model when specified", async () => {
    const customProvider = new OpenAIProvider("key", "gpt-4-turbo-custom");

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Review" } }],
      usage: null,
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
    };

    const result = await customProvider.review(request);

    expect(result.model).toBe("gpt-4-turbo-custom");
  });

  it("includes focus areas in prompt when provided", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Review" } }],
      usage: null,
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
      focusAreas: ["Security", "Performance"],
    };

    await provider.review(request);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages[1].content).toContain("Security");
    expect(callArgs.messages[1].content).toContain("Performance");
  });

  it("includes custom prompt in request when provided", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Review" } }],
      usage: null,
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
      customPrompt: "Pay special attention to error handling",
    };

    await provider.review(request);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages[1].content).toContain("Pay special attention to error handling");
  });

  it("sets max_completion_tokens and default temperature", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Review" } }],
      usage: null,
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
    };

    await provider.review(request);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.max_completion_tokens).toBe(8192);
    expect(callArgs.temperature).toBe(0.3);
  });

  it("uses custom temperature when provided", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Review" } }],
      usage: null,
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
      temperature: 0.8,
    };

    await provider.review(request);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.temperature).toBe(0.8);
  });

  it("uses zero temperature when explicitly set", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Review" } }],
      usage: null,
    });

    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
      temperature: 0,
    };

    await provider.review(request);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.temperature).toBe(0);
  });
});
