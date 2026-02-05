import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export const ConfigSchema = z.object({
  geminiApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  defaultProvider: z.enum(["gemini", "openai"]).default("gemini"),
  geminiModel: z.string().default("gemini-3-flash-preview"),
  openaiModel: z.string().default("gpt-5.2"),
  maxContextTokens: z.number().default(100000),
  reviewsDir: z.string().default("second-opinions"),
  /** Default temperature for LLM generation (0-1) */
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
        `Warning: Invalid JSON in config file ${configPath}. Using defaults.`
      );
    }
  }

  const config = ConfigSchema.parse({
    geminiApiKey: process.env.GEMINI_API_KEY || fileConfig.geminiApiKey,
    openaiApiKey: process.env.OPENAI_API_KEY || fileConfig.openaiApiKey,
    defaultProvider: process.env.DEFAULT_PROVIDER || fileConfig.defaultProvider,
    geminiModel: process.env.GEMINI_MODEL || fileConfig.geminiModel,
    openaiModel: process.env.OPENAI_MODEL || fileConfig.openaiModel,
    maxContextTokens: process.env.MAX_CONTEXT_TOKENS
      ? parseInt(process.env.MAX_CONTEXT_TOKENS)
      : fileConfig.maxContextTokens,
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

  // Default instructions
  return `# Code Review Instructions

You are a code reviewer providing a second opinion on code changes.

## Your Role
- Review the code changes objectively
- Identify potential issues, bugs, or improvements
- Be constructive and specific in your feedback
- Consider security, performance, and maintainability

## Review Focus
- Security vulnerabilities and best practices
- Performance considerations
- Code clarity and maintainability
- Error handling and edge cases
- Testing coverage

## Output Format
Structure your review with:
1. **Summary** (2-3 sentences overview)
2. **Critical Issues** (if any - things that must be fixed)
3. **Suggestions** (improvements that would be nice)
4. **What's Done Well** (positive feedback)
`;
}
