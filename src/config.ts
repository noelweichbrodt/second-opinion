import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export const ConfigSchema = z.object({
  geminiApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  defaultProvider: z.enum(["gemini", "openai", "consensus"]).default("consensus"),
  geminiModel: z.string().default("gemini-3-flash-preview"),
  openaiModel: z.string().default("gpt-5.2"),
  maxContextTokens: z.number().default(200000),
  /** Maximum output tokens for LLM response generation */
  maxOutputTokens: z.number().default(32768),
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
        `Warning: Invalid JSON in config file ${configPath}. Using defaults.`,
        error instanceof Error ? error.message : String(error)
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

  // Default instructions — mirrors templates/second-opinion.md
  return `# Code Review Methodology

## Approach: Phased Review

Work through these phases in order:

### Phase 1: Understand the Change
- Read the conversation context to understand what was requested
- Identify the scope: which files changed, what's the intent

### Phase 2: Architectural Assessment
- Does this change fit existing patterns?
- Are abstractions at the right level?
- Trace call chains: do contracts hold across layer boundaries?

### Phase 3: Detailed Analysis
- Correctness, security, performance, error handling, edge cases

When a branch diff is provided:
- Primary focus: code that appears in the diff (new/changed lines)
- Use the diff to determine if an issue is newly introduced or pre-existing
- Findings section = only issues in the diff
- Pre-existing Issues section = legitimate issues NOT in the diff

### Phase 4: Self-Interrogation
For each finding: form it as a question, search the code for evidence, then:
- Confirmed → include as a finding with evidence
- Ambiguous → list under Questions
- Contradicted → discard

## Severity Labels
- **[BLOCKING]** — Must fix. Quote the code (\`file:line\` + snippet).
- **[IMPORTANT]** — Should fix. Reference \`file:line\`.
- **[NIT]** — Nice to have. At minimum a file reference.
- **[SUGGESTION]** — Alternative approach. Include rationale.
- **[PRAISE]** — Good work. Reference specific code.

## Beyond the Diff
- **Think Upstream**: "What would have to be true for this problem not to exist?"
- **Think Downstream**: "What assumptions does this change bake in, and who inherits them?"
- You have permission to suggest breaking changes, question requirements, or propose removing code. Label confidence: Safe / Worth Investigating / Bold.

## Output Format
### Summary
Brief overall assessment.

### Findings
Ordered by severity, every finding grounded in specific code.
When a branch diff is provided, only include issues introduced by the diff.

### Pre-existing Issues
(Include only when a branch diff is provided and pre-existing issues are found.)
Issues found in reviewed files that were NOT introduced by this change.
Same severity labels and evidence requirements as Findings.

### Questions
Findings that couldn't be fully grounded.

### Upstream/Downstream Opportunities
Architectural suggestions beyond the current change.
- **What/Where** · **Why** · **Risk Level**: Safe / Worth Investigating / Bold

### What's Done Well
**[PRAISE]** labels with file references.
`;
}
