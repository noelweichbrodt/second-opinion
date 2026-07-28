import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

export const ConfigSchema = z.object({
  geminiApiKey: z.string().optional(),
  geminiModel: z.string().default("gemini-pro-latest"),
  codexModel: z.string().default("gpt-5.6-sol"),
  maxContextTokens: z.number().default(200000),
  /** Maximum output tokens for LLM response generation */
  maxOutputTokens: z.number().default(32768),
  reviewsDir: z.string().default("second-opinions"),
  /** Default temperature for Gemini generation (0-1); Codex ignores it. */
  temperature: z.number().min(0).max(1).default(0.3),
  /** Rate limit window in milliseconds */
  rateLimitWindowMs: z.number().positive().default(60000),
  /** Maximum requests per rate limit window */
  rateLimitMaxRequests: z.number().positive().default(10),
});

export type Config = z.infer<typeof ConfigSchema>;

export function getConfigDir(): string {
  return path.join(os.homedir(), ".config", "second-opinion");
}

export function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

export function loadConfig(): Config {
  const configDir = getConfigDir();
  const configPath = path.join(configDir, "config.json");

  let fileConfig: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (error) {
      console.error(
        `Warning: Invalid JSON in config file ${configPath}. Using defaults.`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  const config = ConfigSchema.parse({
    geminiApiKey: process.env.GEMINI_API_KEY || fileConfig.geminiApiKey,
    geminiModel: process.env.GEMINI_MODEL || fileConfig.geminiModel,
    codexModel: process.env.CODEX_MODEL || fileConfig.codexModel,
    maxContextTokens: process.env.MAX_CONTEXT_TOKENS
      ? parseInt(process.env.MAX_CONTEXT_TOKENS)
      : fileConfig.maxContextTokens,
    maxOutputTokens: process.env.MAX_OUTPUT_TOKENS
      ? parseInt(process.env.MAX_OUTPUT_TOKENS)
      : fileConfig.maxOutputTokens,
    reviewsDir: process.env.REVIEWS_DIR || fileConfig.reviewsDir,
    temperature: process.env.TEMPERATURE
      ? parseFloat(process.env.TEMPERATURE)
      : fileConfig.temperature,
    rateLimitWindowMs: process.env.RATE_LIMIT_WINDOW_MS
      ? parseInt(process.env.RATE_LIMIT_WINDOW_MS)
      : fileConfig.rateLimitWindowMs,
    rateLimitMaxRequests: process.env.RATE_LIMIT_MAX_REQUESTS
      ? parseInt(process.env.RATE_LIMIT_MAX_REQUESTS)
      : fileConfig.rateLimitMaxRequests,
  });

  return config;
}

/**
 * Path to the canonical methodology template that ships inside the package.
 * Resolves from both src/ (dev, tests) and dist/ (built) because each sits one
 * level below the package root.
 */
export function getPackagedTemplatePath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(moduleDir, "..", "templates", "second-opinion.md");
}

export function loadReviewInstructions(projectPath?: string): string {
  const configDir = getConfigDir();

  // Check project-local first
  if (projectPath) {
    const projectInstructions = path.join(projectPath, "second-opinion.md");
    if (fs.existsSync(projectInstructions)) {
      return fs.readFileSync(projectInstructions, "utf-8");
    }
  }

  // Fall back to global
  const globalInstructions = path.join(configDir, "second-opinion.md");
  if (fs.existsSync(globalInstructions)) {
    return fs.readFileSync(globalInstructions, "utf-8");
  }

  // Fall back to the packaged canonical template. A second, abbreviated copy
  // of the methodology used to live here and drifted; the packaged file is
  // the single source of truth.
  const packagedTemplate = getPackagedTemplatePath();
  if (fs.existsSync(packagedTemplate)) {
    return fs.readFileSync(packagedTemplate, "utf-8");
  }

  throw new Error(
    `Review methodology not found. Checked project (${
      projectPath ? path.join(projectPath, "second-opinion.md") : "n/a"
    }), global (${globalInstructions}), and packaged (${packagedTemplate}). ` +
      "Reinstall second-opinion-mcp or run scripts/install-config.js."
  );
}
