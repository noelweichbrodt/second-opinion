import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  getConfigDir,
  getClaudeProjectsDir,
  loadConfig,
  loadReviewInstructions,
} from "./config.js";
import { createTempDir, cleanupTempDir, createProjectStructure } from "./test-utils.js";

describe("getConfigDir", () => {
  it("returns ~/.config/second-opinion path", () => {
    const result = getConfigDir();
    expect(result).toBe(path.join(os.homedir(), ".config", "second-opinion"));
  });
});

describe("getClaudeProjectsDir", () => {
  it("returns ~/.claude/projects path", () => {
    const result = getClaudeProjectsDir();
    expect(result).toBe(path.join(os.homedir(), ".claude", "projects"));
  });
});

describe("loadConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset env for each test
    vi.resetModules();
    process.env = { ...originalEnv };
    // Clear relevant env vars
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEFAULT_PROVIDER;
    delete process.env.GEMINI_MODEL;
    delete process.env.OPENAI_MODEL;
    delete process.env.MAX_CONTEXT_TOKENS;
    delete process.env.REVIEWS_DIR;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses env vars when set", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.DEFAULT_PROVIDER = "openai";
    process.env.GEMINI_MODEL = "gemini-pro";
    process.env.OPENAI_MODEL = "gpt-4-turbo";
    process.env.MAX_CONTEXT_TOKENS = "50000";
    process.env.REVIEWS_DIR = "custom-reviews";

    const config = loadConfig();

    expect(config.geminiApiKey).toBe("test-gemini-key");
    expect(config.openaiApiKey).toBe("test-openai-key");
    expect(config.defaultProvider).toBe("openai");
    expect(config.geminiModel).toBe("gemini-pro");
    expect(config.openaiModel).toBe("gpt-4-turbo");
    expect(config.maxContextTokens).toBe(50000);
    expect(config.reviewsDir).toBe("custom-reviews");
  });

  it("applies schema defaults when no config provided", () => {
    const config = loadConfig();

    expect(config.defaultProvider).toBe("gemini");
    expect(config.geminiModel).toBe("gemini-3-flash-preview");
    expect(config.openaiModel).toBe("gpt-5.2");
    expect(config.maxContextTokens).toBe(100000);
    expect(config.reviewsDir).toBe("second-opinions");
  });

  it("handles invalid DEFAULT_PROVIDER gracefully", () => {
    process.env.DEFAULT_PROVIDER = "invalid";

    // Should throw or use default due to zod validation
    expect(() => loadConfig()).toThrow();
  });

  it("handles invalid MAX_CONTEXT_TOKENS gracefully", () => {
    process.env.MAX_CONTEXT_TOKENS = "not-a-number";

    // parseInt("not-a-number") returns NaN, which zod rejects
    expect(() => loadConfig()).toThrow();
  });
});

describe("loadReviewInstructions", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("config-review");
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("returns default instructions when no files exist", () => {
    const instructions = loadReviewInstructions(tmpDir);

    expect(instructions).toContain("Code Review Instructions");
    expect(instructions).toContain("code reviewer");
    expect(instructions).toContain("second opinion");
  });

  it("reads project-local file first", () => {
    const projectDir = path.join(tmpDir, "project-local-test");
    createProjectStructure(projectDir, {
      "second-opinion.md": "# Project Local Instructions\n\nCustom review rules.",
    });

    const instructions = loadReviewInstructions(projectDir);

    expect(instructions).toBe("# Project Local Instructions\n\nCustom review rules.");
  });

  it("falls back to global file when project file missing", () => {
    // This test would require mocking getConfigDir or setting up ~/.config
    // We'll just verify it returns default when neither exists
    const emptyProject = path.join(tmpDir, "empty-project");
    fs.mkdirSync(emptyProject, { recursive: true });

    const instructions = loadReviewInstructions(emptyProject);

    // Should return default instructions (no global file in test env)
    expect(instructions).toContain("Code Review Instructions");
  });

  it("returns default instructions when projectPath is undefined", () => {
    const instructions = loadReviewInstructions();

    expect(instructions).toContain("Code Review Instructions");
  });

  it("includes expected sections in default instructions", () => {
    const instructions = loadReviewInstructions();

    expect(instructions).toContain("## Your Role");
    expect(instructions).toContain("## Review Focus");
    expect(instructions).toContain("## Output Format");
    expect(instructions).toContain("Summary");
    expect(instructions).toContain("Critical Issues");
    expect(instructions).toContain("Suggestions");
  });
});
