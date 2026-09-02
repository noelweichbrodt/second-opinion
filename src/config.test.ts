import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  ConfigSchema,
  getConfigDir,
  getClaudeProjectsDir,
  getPackagedTemplatePath,
  loadConfig,
  loadReviewInstructions,
} from "./config.js";
import { createTempDir, cleanupTempDir, createProjectStructure } from "./test-utils.js";

// Hermetic home for loadConfig tests: loadConfig merges
// ~/.config/second-opinion/config.json, so homedir must be redirectable to an
// empty temp dir or a developer's personal config leaks into assertions.
// ESM namespace exports cannot be spied on, so the module itself is mocked.
const osMock = vi.hoisted(() => ({
  homedirOverride: undefined as string | undefined,
}));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    homedir: () => osMock.homedirOverride ?? actual.homedir(),
  };
});

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
  let fakeHome: string;

  beforeEach(() => {
    // Reset env for each test
    vi.resetModules();
    process.env = { ...originalEnv };
    fakeHome = createTempDir("config-home");
    osMock.homedirOverride = fakeHome;
    // Clear relevant env vars
    delete process.env.GEMINI_API_KEY;
    delete process.env.DEFAULT_PROVIDER;
    delete process.env.GEMINI_MODEL;
    delete process.env.CODEX_MODEL;
    delete process.env.MAX_CONTEXT_TOKENS;
    delete process.env.MAX_OUTPUT_TOKENS;
    delete process.env.REVIEWS_DIR;
    delete process.env.TEMPERATURE;
    delete process.env.RATE_LIMIT_WINDOW_MS;
    delete process.env.RATE_LIMIT_MAX_REQUESTS;
  });

  afterEach(() => {
    process.env = originalEnv;
    osMock.homedirOverride = undefined;
    cleanupTempDir(fakeHome);
  });

  it("uses env vars when set", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.GEMINI_MODEL = "gemini-pro";
    process.env.CODEX_MODEL = "gpt-5.6-sol-custom";
    process.env.MAX_CONTEXT_TOKENS = "50000";
    process.env.MAX_OUTPUT_TOKENS = "16000";
    process.env.REVIEWS_DIR = "custom-reviews";
    process.env.TEMPERATURE = "0.7";
    process.env.RATE_LIMIT_WINDOW_MS = "30000";
    process.env.RATE_LIMIT_MAX_REQUESTS = "5";

    const config = loadConfig();

    expect(config.geminiApiKey).toBe("test-gemini-key");
    expect(config.geminiModel).toBe("gemini-pro");
    expect(config.codexModel).toBe("gpt-5.6-sol-custom");
    expect(config.maxContextTokens).toBe(50000);
    expect(config.maxOutputTokens).toBe(16000);
    expect(config.reviewsDir).toBe("custom-reviews");
    expect(config.temperature).toBe(0.7);
    expect(config.rateLimitWindowMs).toBe(30000);
    expect(config.rateLimitMaxRequests).toBe(5);
  });

  it("applies schema defaults when no config provided", () => {
    const config = loadConfig();

    expect(config.geminiModel).toBe("gemini-flash-latest");
    expect(config.codexModel).toBe("gpt-5.6-sol");
    expect(config.maxContextTokens).toBe(200000);
    expect(config.maxOutputTokens).toBe(32768);
    expect(config.reviewsDir).toBe("second-opinions");
    expect(config.temperature).toBe(0.3);
    expect(config.rateLimitWindowMs).toBe(60000);
    expect(config.rateLimitMaxRequests).toBe(10);
  });

  it("ignores the removed DEFAULT_PROVIDER variable", () => {
    // The provider is required per call; a config default would silently
    // compete with the skill's explicit provider selection.
    process.env.DEFAULT_PROVIDER = "gemini";

    const config = loadConfig();

    expect(config).not.toHaveProperty("defaultProvider");
  });

  it("handles invalid MAX_CONTEXT_TOKENS gracefully", () => {
    process.env.MAX_CONTEXT_TOKENS = "not-a-number";

    // parseInt("not-a-number") returns NaN, which zod rejects
    expect(() => loadConfig()).toThrow();
  });

  it("ignores legacy OpenAI environment variables", () => {
    process.env.OPENAI_API_KEY = "legacy-openai-key";
    process.env.OPENAI_MODEL = "legacy-openai-model";

    const config = loadConfig();

    expect(config).not.toHaveProperty("openaiApiKey");
    expect(config).not.toHaveProperty("openaiModel");
    expect(config.codexModel).toBe("gpt-5.6-sol");
  });
});

describe("ConfigSchema", () => {
  it("exposes the Codex handoff model without OpenAI API settings", () => {
    const config = ConfigSchema.parse({
      openaiApiKey: "legacy-key",
      openaiModel: "legacy-model",
    });

    expect(config.codexModel).toBe("gpt-5.6-sol");
    expect(config).not.toHaveProperty("openaiApiKey");
    expect(config).not.toHaveProperty("openaiModel");
  });

  it("has no default-provider setting", () => {
    const config = ConfigSchema.parse({ defaultProvider: "openai" });

    expect(config).not.toHaveProperty("defaultProvider");
  });

  it("validates Gemini-only temperature bounds", () => {
    expect(ConfigSchema.parse({ temperature: 0 }).temperature).toBe(0);
    expect(ConfigSchema.parse({ temperature: 1 }).temperature).toBe(1);
    expect(() => ConfigSchema.parse({ temperature: -0.1 })).toThrow();
    expect(() => ConfigSchema.parse({ temperature: 1.1 })).toThrow();
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

    // May load global config file or hardcoded default — both have review methodology
    expect(instructions.length).toBeGreaterThan(100);
    expect(instructions).toContain("Review");
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
    const emptyProject = path.join(tmpDir, "empty-project");
    fs.mkdirSync(emptyProject, { recursive: true });

    const instructions = loadReviewInstructions(emptyProject);

    // May load global config file or hardcoded default
    expect(instructions.length).toBeGreaterThan(100);
    expect(instructions).toContain("Review");
  });

  it("returns default instructions when projectPath is undefined", () => {
    const instructions = loadReviewInstructions();

    expect(instructions.length).toBeGreaterThan(100);
    expect(instructions).toContain("Review");
  });

  it("includes expected sections in default instructions", () => {
    // Pass a tmpDir with no second-opinion.md (skips project-local),
    // and the global config is the old template — so test the hardcoded
    // default by loading it from a path with no files at any level.
    // Since we can't easily mock fs.existsSync in ESM, we directly
    // verify the hardcoded default string returned by the function.
    const emptyDir = path.join(tmpDir, "hardcoded-sections-test");
    fs.mkdirSync(emptyDir, { recursive: true });

    // loadReviewInstructions with emptyDir falls through project-local,
    // then hits the global file. To test the hardcoded default, we check
    // the returned string from loadConfig's internal default.
    const instructions = loadReviewInstructions(emptyDir);

    // loadReviewInstructions may return a global file or the hardcoded default.
    // Verify it returns non-empty review instructions with common structural elements.
    expect(instructions.length).toBeGreaterThan(100);
    expect(instructions).toContain("Summary");
    expect(instructions).toContain("Output Format");
  });

  it("packaged fallback is byte-identical to the canonical template", () => {
    // The abbreviated embedded copy drifted from templates/second-opinion.md
    // and was removed; the fallback now reads the packaged canonical file.
    const packaged = fs.readFileSync(getPackagedTemplatePath(), "utf-8");
    const canonical = fs.readFileSync(
      path.resolve("templates/second-opinion.md"),
      "utf-8"
    );

    expect(packaged).toBe(canonical);
    expect(packaged).toContain("Phased Review");
    expect(packaged).toContain("Self-Interrogation");
    expect(packaged).toContain("Triage Defensive Findings to the Right Altitude");
  });

  it("canonical template still carries everything the review nucleus delegates", () => {
    // The R1 trim (plans/r1-r3-eval-results.md) removed the phase structure,
    // severity ladder and diff/pre-existing split from the system prompt on the
    // grounds that <instructions> already states them. That made these headings
    // load-bearing rather than belt-and-braces: trimming one here would leave
    // the review prompt stating it nowhere.
    //
    // The list lives in templates/methodology-manifest.json because the
    // installer warns on the same anchors when it finds a customized
    // methodology; two hand-maintained copies would drift.
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve("templates/methodology-manifest.json"), "utf-8")
    ) as { anchors: string[] };
    const canonical = fs.readFileSync(
      path.resolve("templates/second-opinion.md"),
      "utf-8"
    );

    expect(manifest.anchors.length).toBeGreaterThan(0);
    for (const anchor of manifest.anchors) {
      expect(canonical).toContain(anchor);
    }
  });

  it("fallback with no project or global file loads the canonical template", () => {
    // Redirect home to an empty temp dir so no developer-installed
    // ~/.config/second-opinion/second-opinion.md can satisfy the global
    // branch; this exercises the packaged-template fallback end to end.
    const fakeHome = createTempDir("fallback-home");
    osMock.homedirOverride = fakeHome;
    try {
      const emptyProject = path.join(tmpDir, "fallback-canonical");
      fs.mkdirSync(emptyProject, { recursive: true });

      const instructions = loadReviewInstructions(emptyProject);
      const canonical = fs.readFileSync(
        path.resolve("templates/second-opinion.md"),
        "utf-8"
      );

      expect(instructions).toBe(canonical);
    } finally {
      osMock.homedirOverride = undefined;
      cleanupTempDir(fakeHome);
    }
  });
});
