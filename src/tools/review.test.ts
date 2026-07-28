import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  SecondOpinionInputSchema,
  executeReview,
  resetRateLimiter,
} from "./review.js";
import { verifyReviewFile } from "../output/verify-review.js";
import { CODEX_REVIEW_PLACEHOLDER } from "../providers/codex.js";
import { getRateLimiter } from "../security/rate-limiter.js";
import { createTempDir, cleanupTempDir, createProjectStructure } from "../test-utils.js";

const mockConfigState = vi.hoisted(() => ({
  geminiApiKey: "test-gemini-key" as string | undefined,
  maxContextTokens: 100000,
}));

// Mock the config module
vi.mock("../config.js", () => ({
  loadConfig: () => ({
    geminiApiKey: mockConfigState.geminiApiKey,
    geminiModel: "gemini-2.0-flash-exp",
    codexModel: "gpt-5.6-sol",
    maxContextTokens: mockConfigState.maxContextTokens,
    maxOutputTokens: 32768,
    reviewsDir: "second-opinions",
    temperature: 0.3,
    rateLimitWindowMs: 60000,
    rateLimitMaxRequests: 10,
  }),
  loadReviewInstructions: () => "# Review Instructions\nBe constructive.",
  getClaudeProjectsDir: () => "/mock/projects",
}));

// Mock the providers
vi.mock("../providers/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../providers/index.js")>();

  return {
    ...actual,
    createProvider: vi.fn().mockReturnValue({
      name: "gemini",
      review: vi.fn().mockResolvedValue({
        review: "# Mock Review\n\nLooks good!",
        model: "gemini-2.0-flash-exp",
        tokensUsed: 500,
      }),
    }),
    getConsensusReview: vi.fn(
      async (
        _request: unknown,
        config: { geminiModel: string },
        codex: unknown
      ) => ({
        gemini: {
          review: "# Gemini Review\n\nLooks good from Gemini!",
          model: config.geminiModel,
          tokensUsed: 400,
        },
        codex,
      })
    ),
  };
});

beforeEach(() => {
  mockConfigState.geminiApiKey = "test-gemini-key";
  mockConfigState.maxContextTokens = 100000;
  resetRateLimiter();
});

describe("SecondOpinionInputSchema", () => {
  it("validates minimal required fields", () => {
    const input = {
      provider: "gemini",
      projectPath: "/test/project",
    };

    const result = SecondOpinionInputSchema.parse(input);

    expect(result.provider).toBe("gemini");
    expect(result.projectPath).toBe("/test/project");
  });

  it("applies default values", () => {
    const input = {
      provider: "openai",
      projectPath: "/test/project",
    };

    const result = SecondOpinionInputSchema.parse(input);

    expect(result.provider).toBe("codex");
    expect(result.includeConversation).toBe(true);
    expect(result.includeDependencies).toBe(true);
    expect(result.includeDependents).toBe(true);
    expect(result.includeTests).toBe(true);
    expect(result.includeTypes).toBe(true);
    // No schema default: an omitted maxInputTokens must fall through to the
    // MAX_CONTEXT_TOKENS config in executeReview, which a zod default here
    // used to shadow.
    expect(result.maxInputTokens).toBeUndefined();
    expect(result.allowExternalFiles).toBe(false);
    expect(result.dryRun).toBe(false);
  });

  it("validates provider enum", () => {
    const validGemini = SecondOpinionInputSchema.safeParse({
      provider: "gemini",
      projectPath: "/test",
    });
    const validCodex = SecondOpinionInputSchema.safeParse({
      provider: "codex",
      projectPath: "/test",
    });
    const validConsensus = SecondOpinionInputSchema.safeParse({
      provider: "consensus",
      projectPath: "/test",
    });
    const validOpenai = SecondOpinionInputSchema.safeParse({
      provider: "openai",
      projectPath: "/test",
    });
    const invalid = SecondOpinionInputSchema.safeParse({
      provider: "invalid",
      projectPath: "/test",
    });

    expect(validGemini.success).toBe(true);
    expect(validCodex.success).toBe(true);
    expect(validConsensus.success).toBe(true);
    expect(validOpenai.success).toBe(true);
    if (validOpenai.success) {
      expect(validOpenai.data.provider).toBe("codex");
    }
    expect(invalid.success).toBe(false);
  });

  it("accepts optional task parameter", () => {
    const input = {
      provider: "gemini",
      projectPath: "/test",
      task: "Analyze security vulnerabilities",
    };

    const result = SecondOpinionInputSchema.parse(input);

    expect(result.task).toBe("Analyze security vulnerabilities");
  });

  it("accepts optional includeFiles array", () => {
    const input = {
      provider: "gemini",
      projectPath: "/test",
      includeFiles: ["src/index.ts", "lib/utils.ts"],
    };

    const result = SecondOpinionInputSchema.parse(input);

    expect(result.includeFiles).toEqual(["src/index.ts", "lib/utils.ts"]);
  });

  it("accepts optional focusAreas array", () => {
    const input = {
      provider: "gemini",
      projectPath: "/test",
      focusAreas: ["Security", "Performance"],
    };

    const result = SecondOpinionInputSchema.parse(input);

    expect(result.focusAreas).toEqual(["Security", "Performance"]);
  });

  it("accepts all optional parameters", () => {
    const input = {
      provider: "codex",
      projectPath: "/test",
      task: "Review code",
      sessionId: "abc-123",
      includeFiles: ["file.ts"],
      allowExternalFiles: true,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      maxInputTokens: 50000,
      sessionName: "custom-name",
      customPrompt: "Be brief",
      focusAreas: ["Errors"],
      dryRun: true,
    };

    const result = SecondOpinionInputSchema.parse(input);

    expect(result.task).toBe("Review code");
    expect(result.allowExternalFiles).toBe(true);
    expect(result.includeConversation).toBe(false);
    expect(result.maxInputTokens).toBe(50000);
    expect(result.dryRun).toBe(true);
  });
});

describe("executeReview - projectPath validation", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("review-validation");
    createProjectStructure(tmpDir, {
      "src/index.ts": "export const main = 1;",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("throws on relative projectPath", async () => {
    await expect(
      executeReview({
        provider: "gemini",
        projectPath: "relative/path",
        includeConversation: false,
        includeDependencies: false,
        includeDependents: false,
        includeTests: false,
        includeTypes: false,
        dryRun: true,
      })
    ).rejects.toThrow("projectPath must be absolute");
  });

  it("throws on path traversal in projectPath", async () => {
    await expect(
      executeReview({
        provider: "gemini",
        projectPath: "/valid/path/../../../etc",
        includeConversation: false,
        includeDependencies: false,
        includeDependents: false,
        includeTests: false,
        includeTypes: false,
        dryRun: true,
      })
    ).rejects.toThrow("path traversal");
  });

  it("throws on non-existent projectPath", async () => {
    await expect(
      executeReview({
        provider: "gemini",
        projectPath: "/nonexistent/project/path",
        includeConversation: false,
        includeDependencies: false,
        includeDependents: false,
        includeTests: false,
        includeTypes: false,
        dryRun: true,
      })
    ).rejects.toThrow("does not exist");
  });

  it("throws when projectPath is a file", async () => {
    await expect(
      executeReview({
        provider: "gemini",
        projectPath: path.join(tmpDir, "src/index.ts"),
        includeConversation: false,
        includeDependencies: false,
        includeDependents: false,
        includeTests: false,
        includeTypes: false,
        dryRun: true,
      })
    ).rejects.toThrow("not a directory");
  });

  it("accepts valid absolute directory path", async () => {
    // This should not throw (validation passes)
    const result = await executeReview({
      provider: "gemini",
      projectPath: tmpDir,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
  });
});

describe("executeReview - dry run mode", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("review-dryrun");
    createProjectStructure(tmpDir, {
      "src/index.ts": "export const main = 1;",
      "src/utils.ts": "export const util = 1;",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("returns dry run result without calling provider", async () => {
    const result = await executeReview({
      provider: "gemini",
      projectPath: tmpDir,
      includeFiles: ["src/index.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.provider).toBe("gemini");
    expect(result.summary).toBeDefined();
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it("includes egress summary in dry run", async () => {
    const result = await executeReview({
      provider: "gemini",
      projectPath: tmpDir,
      includeFiles: ["src/index.ts", "src/utils.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      dryRun: true,
    });

    if (!result.dryRun) throw new Error("Expected dry run");

    expect(result.summary.projectFilesSent).toBeGreaterThan(0);
    expect(result.summary.projectFilePaths.length).toBeGreaterThan(0);
  });

  it("does not create output files in dry run", async () => {
    const outputDir = path.join(tmpDir, "second-opinions");

    await executeReview({
      provider: "gemini",
      projectPath: tmpDir,
      includeFiles: ["src/index.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      dryRun: true,
    });

    // Output directory should not be created in dry run
    expect(fs.existsSync(outputDir)).toBe(false);
  });
});

describe("executeReview - actual execution", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("review-exec");
    createProjectStructure(tmpDir, {
      "src/index.ts": "export const main = 1;",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns review result with all fields", async () => {
    const result = await executeReview({
      provider: "gemini",
      projectPath: tmpDir,
      includeFiles: ["src/index.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      dryRun: false,
    });

    if (result.dryRun) throw new Error("Expected actual execution");

    expect(result.review).toBeDefined();
    expect(result.reviewFile).toBeDefined();
    expect(result.egressManifestFile).toBeDefined();
    expect(result.provider).toBe("gemini");
    expect(result.model).toBeDefined();
    expect(result.timestamp).toBeDefined();
    expect(result.filesReviewed).toBeGreaterThan(0);
    expect(result.summary).toBeDefined();
  });

  it("creates review file", async () => {
    const result = await executeReview({
      provider: "gemini",
      projectPath: tmpDir,
      includeFiles: ["src/index.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      sessionName: "test-review",
      dryRun: false,
    });

    if (result.dryRun) throw new Error("Expected actual execution");

    expect(fs.existsSync(result.reviewFile)).toBe(true);
    expect(result.reviewFile).toContain("test-review.gemini");
  });

  it("creates egress manifest file", async () => {
    const result = await executeReview({
      provider: "gemini",
      projectPath: tmpDir,
      includeFiles: ["src/index.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      sessionName: "test-egress",
      dryRun: false,
    });

    if (result.dryRun) throw new Error("Expected actual execution");

    expect(fs.existsSync(result.egressManifestFile)).toBe(true);
    expect(result.egressManifestFile).toContain(".egress.json");
  });

  it("passes task to provider when specified", async () => {
    const { createProvider } = await import("../providers/index.js");

    await executeReview({
      provider: "gemini",
      projectPath: tmpDir,
      task: "Analyze for security issues",
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      dryRun: false,
    });

    const mockProvider = (createProvider as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(mockProvider.review).toHaveBeenCalled();

    const reviewCall = mockProvider.review.mock.calls[0][0];
    expect(reviewCall.task).toBe("Analyze for security issues");
  });
});

describe("executeReview - egress summary", () => {
  let tmpDir: string;
  let externalDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("review-egress");
    externalDir = createTempDir("review-external");

    createProjectStructure(tmpDir, {
      "src/index.ts": "export const main = 1;",
      "src/utils.ts": "export const util = 1;",
    });

    createProjectStructure(externalDir, {
      "lib/helper.ts": "export const helper = 1;",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
    cleanupTempDir(externalDir);
  });

  it("categorizes project files correctly", async () => {
    const result = await executeReview({
      provider: "gemini",
      projectPath: tmpDir,
      includeFiles: ["src/index.ts", "src/utils.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      dryRun: true,
    });

    if (!result.dryRun) throw new Error("Expected dry run");

    expect(result.summary.projectFilesSent).toBe(2);
    expect(result.summary.externalFilesSent).toBe(0);
  });

  it("categorizes external files correctly", async () => {
    const result = await executeReview({
      provider: "gemini",
      projectPath: tmpDir,
      includeFiles: ["src/index.ts", path.join(externalDir, "lib/helper.ts")],
      allowExternalFiles: true,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      dryRun: true,
    });

    if (!result.dryRun) throw new Error("Expected dry run");

    expect(result.summary.projectFilesSent).toBe(1);
    expect(result.summary.externalFilesSent).toBe(1);
    // externalLocations contains parent directories of external files
    // The path may be resolved (e.g., on macOS /var -> /private/var)
    expect(result.summary.externalLocations.length).toBe(1);
    expect(result.summary.externalLocations[0]).toContain("lib");
  });

  it("tracks blocked files in summary", async () => {
    createProjectStructure(tmpDir, {
      ".env": "SECRET=xxx",
    });

    const result = await executeReview({
      provider: "gemini",
      projectPath: tmpDir,
      includeFiles: [".env", "src/index.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      dryRun: true,
    });

    if (!result.dryRun) throw new Error("Expected dry run");

    expect(result.summary.blockedFiles.length).toBeGreaterThan(0);
    expect(result.summary.blockedFiles.some((f) => f.path.includes(".env"))).toBe(true);
  });
});

describe("executeReview - Codex handoff", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("review-codex");
    createProjectStructure(tmpDir, {
      "src/index.ts": "export const main = 1;",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("writes a self-contained prompt, placeholder review, and egress manifest without consuming the limiter", async () => {
    const limiter = getRateLimiter();
    const remainingBefore = limiter.getRemainingRequests();

    const result = await executeReview({
      provider: "codex",
      projectPath: tmpDir,
      includeFiles: ["src/index.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      sessionName: "codex-handoff",
      dryRun: false,
    });

    if (result.dryRun || !result.handoff) {
      throw new Error("Expected Codex handoff");
    }

    expect(result.provider).toBe("codex");
    expect(result.model).toBe("gpt-5.6-sol");
    expect(path.isAbsolute(result.promptFile)).toBe(true);
    expect(result.promptFile).toContain(
      "codex-handoff.codex.review.prompt.md"
    );
    expect(fs.existsSync(result.promptFile)).toBe(true);
    expect(fs.existsSync(result.reviewFile)).toBe(true);
    expect(fs.existsSync(result.egressManifestFile)).toBe(true);

    const prompt = fs.readFileSync(result.promptFile, "utf-8");
    expect(prompt).toContain("Codex External Review Handoff");
    expect(prompt).toContain("read-only task");
    expect(prompt).toContain("Do not modify any files");
    expect(prompt.indexOf("Codex External Review Handoff")).toBeLessThan(
      prompt.indexOf("<system-instructions>")
    );
    expect(prompt.indexOf("<system-instructions>")).toBeLessThan(
      prompt.lastIndexOf("<code-context>")
    );
    expect(prompt.lastIndexOf("<code-context>")).toBeLessThan(
      prompt.indexOf("<instructions>")
    );

    const review = fs.readFileSync(result.reviewFile, "utf-8");
    expect(review).toContain("**Provider:** codex (gpt-5.6-sol)");
    expect(review).toContain(
      "<!-- Paste the verbatim /codex:rescue output below this line -->"
    );

    const manifest = JSON.parse(
      fs.readFileSync(result.egressManifestFile, "utf-8")
    );
    expect(manifest.provider).toBe("codex");
    expect(manifest.model).toBe("gpt-5.6-sol");

    expect(result.rescueCommand).toContain(
      "/codex:rescue --model gpt-5.6-sol --fresh"
    );
    expect(result.rescueCommand).toContain(result.promptFile);
    expect(result.rescueCommand).not.toContain("--effort");
    expect(limiter.getRemainingRequests()).toBe(remainingBefore);
  });

  it("normalizes the deprecated openai alias to a Codex handoff", async () => {
    const input = SecondOpinionInputSchema.parse({
      provider: "openai",
      projectPath: tmpDir,
      includeFiles: ["src/index.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      sessionName: "deprecated-alias",
      dryRun: false,
    });

    const result = await executeReview(input);

    if (result.dryRun || !result.handoff) {
      throw new Error("Expected Codex handoff");
    }

    expect(result.provider).toBe("codex");
    expect(result.promptFile).toContain("deprecated-alias.codex");
  });
});

describe("executeReview - consensus handoff and fallback", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("review-consensus");
    createProjectStructure(tmpDir, {
      "src/index.ts": "export const main = 1;",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("returns Gemini's result with the Codex handoff fields", async () => {
    const result = await executeReview({
      provider: "consensus",
      projectPath: tmpDir,
      includeFiles: ["src/index.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      sessionName: "consensus-review",
      dryRun: false,
    });

    if (result.dryRun || !result.handoff) {
      throw new Error("Expected consensus handoff");
    }

    expect(result.provider).toBe("consensus");
    expect(result.gemini).toEqual(
      expect.objectContaining({
        review: expect.stringContaining("Looks good from Gemini"),
        model: "gemini-2.0-flash-exp",
        tokensUsed: 400,
      })
    );
    expect(result.promptFile).toContain(
      "consensus-review.consensus.review.prompt.md"
    );
    expect(result.rescueCommand).toContain("--model gpt-5.6-sol");
    expect(result.rescueCommand).not.toContain("--effort");

    const review = fs.readFileSync(result.reviewFile, "utf-8");
    expect(review).toContain("## Synthesis");
    expect(review).toContain("## Gemini's Review");
    expect(review).toContain("Looks good from Gemini");
    expect(review).toContain("## Codex Review");
    expect(review).toContain(
      "<!-- Paste the verbatim /codex:rescue output below this line -->"
    );
  });

  it("falls back to a Codex-only handoff when Gemini is not configured", async () => {
    mockConfigState.geminiApiKey = undefined;
    const limiter = getRateLimiter();
    const remainingBefore = limiter.getRemainingRequests();

    const result = await executeReview({
      provider: "consensus",
      projectPath: tmpDir,
      includeFiles: ["src/index.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      sessionName: "consensus-fallback",
      dryRun: false,
    });

    if (result.dryRun || !result.handoff) {
      throw new Error("Expected Codex fallback handoff");
    }

    expect(result.provider).toBe("codex");
    expect(result.summary.provider).toBe("codex");
    expect(result.gemini).toBeUndefined();
    expect(limiter.getRemainingRequests()).toBe(remainingBefore);
  });

  it("degrades a Gemini rate-limit trip to gemini.error without destroying the handoff", async () => {
    const limiter = getRateLimiter();
    for (let i = 0; i < 50 && limiter.checkAndRecord().allowed; i++) {
      // Exhaust the window so the consensus Gemini half is rate limited.
    }

    const result = await executeReview({
      provider: "consensus",
      projectPath: tmpDir,
      includeFiles: ["src/index.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      sessionName: "consensus-rate-limited",
      dryRun: false,
    });

    if (result.dryRun || !result.handoff) {
      throw new Error("Expected consensus handoff despite rate limit");
    }

    expect(result.provider).toBe("consensus");
    expect(result.gemini?.error).toMatch(/Rate limited/);
    expect(fs.existsSync(result.promptFile)).toBe(true);
    expect(fs.existsSync(result.reviewFile)).toBe(true);
    expect(fs.existsSync(result.egressManifestFile)).toBe(true);

    const review = fs.readFileSync(result.reviewFile, "utf-8");
    expect(review).toContain("Rate limited");
    expect(review).toContain(
      "<!-- Paste the verbatim /codex:rescue output below this line -->"
    );
    expect(result.rescueCommand).not.toContain("--effort");
  });

  it("rejects a rate-limited gemini-only call before contacting the API or writing files", async () => {
    const limiter = getRateLimiter();
    for (let i = 0; i < 50 && limiter.checkAndRecord().allowed; i++) {
      // Exhaust the window so the gemini-only path is rate limited.
    }

    await expect(
      executeReview({
        provider: "gemini",
        projectPath: tmpDir,
        includeFiles: ["src/index.ts"],
        includeConversation: false,
        includeDependencies: false,
        includeDependents: false,
        includeTests: false,
        includeTypes: false,
        sessionName: "gemini-rate-limited",
        dryRun: false,
      })
    ).rejects.toThrow(/Rate limited/);

    expect(
      fs.existsSync(
        path.join(
          tmpDir,
          "second-opinions",
          "gemini-rate-limited.gemini.review.md"
        )
      )
    ).toBe(false);
  });

  it("keeps consensus in dry-run output when Gemini is configured", async () => {
    const result = await executeReview({
      provider: "consensus",
      projectPath: tmpDir,
      includeFiles: ["src/index.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.provider).toBe("consensus");
  });
});

describe("executeReview - context budget resolution", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("review-budget-test");
    createProjectStructure(tmpDir, {
      // ~2,500 estimated tokens: over a 500-token config cap, well under 100k.
      "src/big.ts": `// filler\n${"const x = 1;\n".repeat(800)}`,
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("falls back to MAX_CONTEXT_TOKENS config when maxInputTokens is omitted", async () => {
    // The zod input default (200000) used to shadow this config value.
    mockConfigState.maxContextTokens = 500;

    const result = await executeReview({
      provider: "gemini",
      projectPath: tmpDir,
      includeFiles: ["src/big.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      dryRun: true,
    });

    if (!result.dryRun) throw new Error("expected dry run");
    expect(
      result.summary.blockedFiles.some((f) => f.reason === "budget_exceeded")
    ).toBe(true);
  });

  it("lets explicit maxInputTokens override the config cap", async () => {
    mockConfigState.maxContextTokens = 500;

    const result = await executeReview({
      provider: "gemini",
      projectPath: tmpDir,
      includeFiles: ["src/big.ts"],
      maxInputTokens: 50000,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      dryRun: true,
    });

    if (!result.dryRun) throw new Error("expected dry run");
    expect(result.summary.projectFilesSent).toBe(1);
    expect(
      result.summary.blockedFiles.some((f) => f.reason === "budget_exceeded")
    ).toBe(false);
  });
});

describe("executeReview - helper command shell safety", () => {
  let tmpDir: string;

  beforeAll(() => {
    // Spaces and a `$` in the project path: these commands run through Bash,
    // unlike rescueCommand (consumed by a slash-command forwarder).
    tmpDir = createTempDir("review-cmd $afe test");
    createProjectStructure(tmpDir, {
      "src/index.ts": "export const main = 1;",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("quotes paths in verifyCommand and spliceCommand", async () => {
    const result = await executeReview({
      provider: "codex",
      projectPath: tmpDir,
      sessionName: "cmd-safety",
      includeFiles: ["src/index.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      dryRun: false,
    });

    if (result.dryRun || !result.handoff) throw new Error("expected handoff");

    // Every path argument is single-quoted; JOB_ID stays a bare token; the
    // --expect timestamp binds the splice to this exact handoff.
    expect(result.verifyCommand).toMatch(
      /^node '[^']+verify-review\.js' '[^']+\.md'$/
    );
    expect(result.spliceCommand).toMatch(
      /^node '[^']+splice-codex-result\.js' JOB_ID --expect '\d{4}-\d{2}-\d{2}T[^']+' '[^']+\.md'$/
    );
    expect(result.verifyCommand).toContain(`'${result.reviewFile}'`);
    // The bound timestamp is the one written into the review file header.
    const expectMatch = result.spliceCommand.match(/--expect '([^']+)'/);
    expect(
      fs.readFileSync(result.reviewFile, "utf-8")
    ).toContain(`**Date:** ${expectMatch![1]}`);

    // A POSIX-style tokenization of the quoted command yields the review
    // file path intact — spaces and $ preserved, no word-splitting.
    const tokens = result.verifyCommand.match(/'[^']*'|\S+/g)!;
    expect(tokens).toHaveLength(3);
    expect(tokens[2].slice(1, -1)).toBe(result.reviewFile);
    expect(result.reviewFile).toContain(" ");
    expect(result.reviewFile).toContain("$");
  });

  it("verifier stays in lockstep with the real codex-only placeholder body", async () => {
    const result = await executeReview({
      provider: "codex",
      projectPath: tmpDir,
      sessionName: "verify-lockstep",
      includeFiles: ["src/index.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      dryRun: false,
    });

    if (result.dryRun || !result.handoff) throw new Error("expected handoff");

    // Pending: real placeholder body → FAIL.
    expect(verifyReviewFile(result.reviewFile).ok).toBe(false);

    // Near-empty splice: the placeholder body's own boilerplate (the "run
    // the handoff command" text and fenced rescue command) must not count
    // as review content.
    const pending = fs.readFileSync(result.reviewFile, "utf-8");
    fs.writeFileSync(
      result.reviewFile,
      pending.replace(CODEX_REVIEW_PLACEHOLDER, "ok.")
    );
    const nearEmpty = verifyReviewFile(result.reviewFile);
    expect(nearEmpty.ok).toBe(false);
    expect(nearEmpty.message).toContain("empty or too short");

    // Real-sized splice → OK.
    fs.writeFileSync(
      result.reviewFile,
      pending.replace(
        CODEX_REVIEW_PLACEHOLDER,
        "## Summary\n\n" + "Substantive review content. ".repeat(20)
      )
    );
    expect(verifyReviewFile(result.reviewFile).ok).toBe(true);
  });
});

describe("executeReview - replacement task prompt", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("review-task-prompt-test");
    createProjectStructure(tmpDir, {
      "src/index.ts": "export const main = 1;",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("omits review methodology and language hints from task handoffs", async () => {
    const result = await executeReview({
      provider: "codex",
      projectPath: tmpDir,
      task: "Write a migration guide for these changes.",
      sessionName: "task-prompt",
      includeFiles: ["src/index.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      dryRun: false,
    });

    if (result.dryRun || !result.handoff) throw new Error("expected handoff");
    const prompt = fs.readFileSync(result.promptFile, "utf-8");

    expect(prompt).toContain("Write a migration guide");
    expect(prompt).toContain("Ground every claim");
    // Review apparatus stays out of non-review deliverables.
    expect(prompt).not.toContain("# Review Instructions");
    expect(prompt).not.toContain("<reference-instructions>");
    expect(prompt).not.toContain("<language-hints>");
    // Task deliverables must not inherit the review-mode verification block.
    expect(prompt).not.toContain("Verification Requirements");
    expect(prompt).not.toContain("QUOTE the specific code");
    // Both handoff surfaces are task-framed: header and rescue command must
    // not instruct Codex to produce a review.
    expect(prompt).toContain("# Codex External Task Handoff");
    expect(prompt).not.toContain("acting as an external reviewer");
    expect(result.rescueCommand).toContain("task prompt");
    expect(result.rescueCommand).toContain("deliverable markdown");
    // The instruction phrases (not the path, which may contain "review")
    // must not tell Codex to produce a review.
    expect(result.rescueCommand).not.toContain("review prompt");
    expect(result.rescueCommand).not.toContain("review markdown");
  });

  it("keeps methodology and language hints in review handoffs", async () => {
    const result = await executeReview({
      provider: "codex",
      projectPath: tmpDir,
      sessionName: "review-prompt",
      includeFiles: ["src/index.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      dryRun: false,
    });

    if (result.dryRun || !result.handoff) throw new Error("expected handoff");
    const prompt = fs.readFileSync(result.promptFile, "utf-8");

    expect(prompt).toContain("# Review Instructions");
    expect(prompt).toContain("<language-hints>");
    expect(prompt).toContain("Only report issues you can VERIFY");
    expect(prompt).toContain("# Codex External Review Handoff");
    expect(result.rescueCommand).toContain("review prompt");
    expect(result.rescueCommand).toContain("full review markdown");
  });
});
