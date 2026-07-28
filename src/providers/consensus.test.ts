import { beforeEach, describe, expect, it, vi } from "vitest";
import { Config } from "../config.js";
import { formatConsensusOutput } from "../output/consensus-formatter.js";
import { ReviewRequest } from "./base.js";
import { CodexHandoff } from "./codex.js";

const mockGeminiReview = vi.fn();

vi.mock("./gemini.js", () => ({
  GeminiProvider: class MockGeminiProvider {
    name = "gemini";
    review = mockGeminiReview;
    constructor(_apiKey: string, _model: string) {}
  },
}));

import {
  getConsensusReview,
  isConsensusAvailable,
} from "./consensus.js";

const baseConfig = {
  geminiApiKey: "test-gemini-key",
  geminiModel: "gemini-2.0-flash-exp",
  codexModel: "gpt-5.6-sol",
  maxContextTokens: 100000,
  maxOutputTokens: 32768,
  reviewsDir: "second-opinions",
  temperature: 0.3,
  rateLimitWindowMs: 60000,
  rateLimitMaxRequests: 10,
} as Config;

const baseRequest: ReviewRequest = {
  instructions: "Review guidelines",
  context: "# Code\nconst x = 1;",
};

const codexHandoff: CodexHandoff = {
  promptFile: "/project/second-opinions/review.consensus.prompt.md",
  reviewFile: "/project/second-opinions/review.consensus.review.md",
  egressManifestFile:
    "/project/second-opinions/review.consensus.review.egress.json",
  rescueCommand:
    "/codex:rescue --model gpt-5.6-sol --fresh Read the prompt file",
  model: "gpt-5.6-sol",
};

describe("getConsensusReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls Gemini and returns the supplied Codex handoff", async () => {
    mockGeminiReview.mockResolvedValue({
      review: "Gemini review",
      model: "gemini-2.0-flash-exp",
      tokensUsed: 100,
    });

    const result = await getConsensusReview(
      baseRequest,
      baseConfig,
      codexHandoff
    );

    expect(mockGeminiReview).toHaveBeenCalledOnce();
    expect(result.gemini.review).toBe("Gemini review");
    expect(result.codex).toBe(codexHandoff);
  });

  it("throws if the Gemini API key is missing", async () => {
    const configWithoutGemini = {
      ...baseConfig,
      geminiApiKey: undefined,
    } as Config;

    await expect(
      getConsensusReview(baseRequest, configWithoutGemini, codexHandoff)
    ).rejects.toThrow("GEMINI_API_KEY");
    expect(mockGeminiReview).not.toHaveBeenCalled();
  });

  it("preserves the Codex handoff when Gemini fails", async () => {
    mockGeminiReview.mockRejectedValue(new Error("Gemini API error"));

    const result = await getConsensusReview(
      baseRequest,
      baseConfig,
      codexHandoff
    );

    expect(result.gemini).toEqual({
      review: "",
      model: "gemini-2.0-flash-exp",
      error: "Gemini API error",
    });
    expect(result.codex).toBe(codexHandoff);
  });

  it("passes Gemini-only generation options through unchanged", async () => {
    mockGeminiReview.mockResolvedValue({
      review: "Review",
      model: "gemini-2.0-flash-exp",
    });
    const request: ReviewRequest = {
      ...baseRequest,
      temperature: 0.7,
      maxOutputTokens: 1234,
    };

    await getConsensusReview(request, baseConfig, codexHandoff);

    expect(mockGeminiReview).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.7,
        maxOutputTokens: 1234,
      })
    );
  });
});

describe("isConsensusAvailable", () => {
  it("returns true when Gemini is configured", () => {
    expect(isConsensusAvailable(baseConfig)).toBe(true);
  });

  it("returns false when Gemini is not configured", () => {
    expect(
      isConsensusAvailable({
        ...baseConfig,
        geminiApiKey: undefined,
      } as Config)
    ).toBe(false);
  });
});

describe("formatConsensusOutput", () => {
  it("includes the synthesis framework, full Gemini review, and Codex placeholder", () => {
    const output = formatConsensusOutput(
      {
        gemini: {
          review: "## Gemini finding\n\nThe complete Gemini response.",
          model: "gemini-2.0-flash-exp",
          tokensUsed: 42,
        },
        codex: codexHandoff,
      },
      { task: "Assess the refactor" }
    );

    expect(output).toContain("# Consensus Analysis: Assess the refactor");
    expect(output).toContain("## Synthesis");
    expect(output).toContain("both / Gemini only / Codex only");
    expect(output).toContain("## Gemini's Review");
    expect(output).toContain(
      "## Gemini finding\n\nThe complete Gemini response."
    );
    expect(output).toContain("## Codex Review");
    expect(output).toContain(codexHandoff.rescueCommand);
    expect(output).toContain(codexHandoff.promptFile);
    expect(output).toContain(
      "<!-- Paste the verbatim /codex:rescue output below this line -->"
    );
  });

  it("reports Gemini errors while leaving Codex awaiting handoff", () => {
    const output = formatConsensusOutput({
      gemini: {
        review: "",
        model: "gemini-2.0-flash-exp",
        error: "quota exceeded",
      },
      codex: codexHandoff,
    });

    expect(output).toContain("Gemini: Error - quota exceeded");
    expect(output).toContain("Codex: Awaiting handoff");
    expect(output).toContain("> Gemini encountered an error: quota exceeded");
  });
});
