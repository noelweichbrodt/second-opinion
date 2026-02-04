import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { SecondOpinionInputSchema, executeReview } from "./review.js";
import { createTempDir, cleanupTempDir, createProjectStructure } from "../test-utils.js";

// Mock the config module
vi.mock("../config.js", () => ({
  loadConfig: () => ({
    geminiApiKey: "test-gemini-key",
    openaiApiKey: "test-openai-key",
    defaultProvider: "gemini",
    geminiModel: "gemini-2.0-flash-exp",
    openaiModel: "gpt-4o",
    maxContextTokens: 100000,
    reviewsDir: "second-opinions",
  }),
  loadReviewInstructions: () => "# Review Instructions\nBe constructive.",
  getClaudeProjectsDir: () => "/mock/projects",
}));

// Mock the providers
vi.mock("../providers/index.js", () => ({
  createProvider: vi.fn().mockReturnValue({
    name: "gemini",
    review: vi.fn().mockResolvedValue({
      review: "# Mock Review\n\nLooks good!",
      model: "gemini-2.0-flash-exp",
      tokensUsed: 500,
    }),
  }),
}));

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

    expect(result.includeConversation).toBe(true);
    expect(result.includeDependencies).toBe(true);
    expect(result.includeDependents).toBe(true);
    expect(result.includeTests).toBe(true);
    expect(result.includeTypes).toBe(true);
    expect(result.maxTokens).toBe(100000);
    expect(result.allowExternalFiles).toBe(false);
    expect(result.dryRun).toBe(false);
  });

  it("validates provider enum", () => {
    const validGemini = SecondOpinionInputSchema.safeParse({
      provider: "gemini",
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
    expect(validOpenai.success).toBe(true);
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
      provider: "openai",
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
      maxTokens: 50000,
      sessionName: "custom-name",
      customPrompt: "Be brief",
      focusAreas: ["Errors"],
      dryRun: true,
    };

    const result = SecondOpinionInputSchema.parse(input);

    expect(result.task).toBe("Review code");
    expect(result.allowExternalFiles).toBe(true);
    expect(result.includeConversation).toBe(false);
    expect(result.maxTokens).toBe(50000);
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
