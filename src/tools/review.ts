import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { loadConfig, loadReviewInstructions } from "../config.js";
import {
  bundleContext,
  formatBundleAsMarkdown,
  ContextBundle,
  BudgetWarning,
} from "../context/index.js";
import { isWithinProject } from "../context/imports.js";
import { createProvider, ProviderName } from "../providers/index.js";
import {
  writeReview,
  writeEgressManifest,
  deriveSessionName,
  ReviewMetadata,
  EgressSummary,
} from "../output/writer.js";
import { getRateLimiter, resetRateLimiter } from "../security/rate-limiter.js";
import { redactSecrets } from "../security/redactor.js";

/**
 * Validate that a project path is safe to use
 */
function validateProjectPath(projectPath: string): void {
  // Must be absolute
  if (!path.isAbsolute(projectPath)) {
    throw new Error(`projectPath must be absolute, got: ${projectPath}`);
  }

  // Normalize and check for traversal
  const normalized = path.normalize(projectPath);
  if (normalized !== projectPath && projectPath.includes("..")) {
    throw new Error(`projectPath contains path traversal: ${projectPath}`);
  }

  // Must exist
  if (!fs.existsSync(normalized)) {
    throw new Error(`projectPath does not exist: ${normalized}`);
  }

  // Must be a directory
  const stat = fs.statSync(normalized);
  if (!stat.isDirectory()) {
    throw new Error(`projectPath is not a directory: ${normalized}`);
  }
}

export const SecondOpinionInputSchema = z.object({
  // Required
  provider: z
    .enum(["gemini", "openai", "consensus"])
    .describe(
      "Which LLM to use. 'consensus' calls both Gemini and OpenAI in parallel and returns combined results."
    ),
  projectPath: z.string().describe("Absolute path to the project being reviewed"),

  // Task specification
  task: z
    .string()
    .optional()
    .describe(
      "The task or prompt for the LLM to accomplish. When omitted, defaults to code review."
    ),

  // Context options
  sessionId: z
    .string()
    .optional()
    .describe("Claude Code session ID (defaults to most recent)"),
  includeFiles: z
    .array(z.string())
    .optional()
    .describe("Additional files or folders to include (supports ~ and relative paths)"),
  allowExternalFiles: z
    .boolean()
    .default(false)
    .describe(
      "Allow including files outside the project directory. Required when includeFiles contains paths outside the project. Use with caution as these files will be sent to the external LLM."
    ),
  includeConversation: z
    .boolean()
    .default(true)
    .describe("Include conversation context from Claude session"),

  // Smart context options
  includeDependencies: z
    .boolean()
    .default(true)
    .describe("Include files imported by modified files"),
  includeDependents: z
    .boolean()
    .default(true)
    .describe("Include files that import modified files"),
  includeTests: z
    .boolean()
    .default(true)
    .describe("Include corresponding test files"),
  includeTypes: z
    .boolean()
    .default(true)
    .describe("Include referenced type definitions"),
  maxTokens: z
    .number()
    .default(100000)
    .describe("Maximum tokens for context"),

  // PR options
  prNumber: z
    .number()
    .optional()
    .describe(
      "PR number to review. Auto-detects from current branch if omitted."
    ),

  // LLM options
  temperature: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Temperature for LLM generation (0-1). Lower = more focused, higher = more creative. Defaults to 0.3."
    ),

  // Output options
  sessionName: z
    .string()
    .optional()
    .describe("Name for this output (used in filename)"),
  customPrompt: z
    .string()
    .optional()
    .describe("Additional instructions (deprecated: use task instead)"),
  focusAreas: z
    .array(z.string())
    .optional()
    .describe("Specific areas to focus on (for code reviews)"),
  dryRun: z
    .boolean()
    .default(false)
    .describe(
      "If true, return a preview of what would be sent without calling the external API. Use this for confirmation before sending files to external providers."
    ),
});

export type SecondOpinionInput = z.infer<typeof SecondOpinionInputSchema>;

// Re-export for consumers
export type { EgressSummary } from "../output/writer.js";

export interface SecondOpinionDryRunOutput {
  dryRun: true;
  provider: string;
  summary: EgressSummary;
  totalTokens: number;
  /** Warnings about important files being omitted due to budget */
  budgetWarnings: BudgetWarning[];
  /** Human-readable message about the dry run status */
  message: string;
}

export interface SecondOpinionOutput {
  dryRun?: false;
  review: string;
  reviewFile: string;
  egressManifestFile: string;
  provider: string;
  model: string;
  tokensUsed?: number;
  timestamp: string;
  filesReviewed: number;
  contextTokens: number;
  summary: EgressSummary;
}

/**
 * Build egress summary from bundle, categorizing files as project vs external
 */
function buildEgressSummary(
  bundle: ContextBundle,
  projectPath: string,
  provider: string
): EgressSummary {
  const projectFilePaths = bundle.files
    .filter((f) => isWithinProject(f.path, projectPath))
    .map((f) => f.path);
  const externalFilePaths = bundle.files
    .filter((f) => !isWithinProject(f.path, projectPath))
    .map((f) => f.path);

  const { redactionStats, prMetadata } = bundle;

  return {
    projectFilesSent: projectFilePaths.length,
    projectFilePaths,
    externalFilesSent: externalFilePaths.length,
    externalFilePaths,
    externalLocations: [...new Set(externalFilePaths.map((p) => path.dirname(p)))],
    blockedFiles: bundle.omittedFiles.map((f) => ({ path: f.path, reason: f.reason })),
    provider,
    redactions:
      redactionStats.totalCount > 0
        ? { totalCount: redactionStats.totalCount, types: redactionStats.types }
        : undefined,
    prContext: prMetadata
      ? {
          prNumber: prMetadata.number,
          prUrl: prMetadata.url,
          commentsIncluded: prMetadata.commentsCount,
          reviewsIncluded: prMetadata.reviewsCount,
        }
      : undefined,
  };
}

export async function executeReview(
  input: SecondOpinionInput
): Promise<SecondOpinionOutput | SecondOpinionDryRunOutput> {
  // Validate project path before proceeding
  validateProjectPath(input.projectPath);

  const config = loadConfig();

  // 1. Bundle the context
  const bundle = await bundleContext({
    projectPath: input.projectPath,
    sessionId: input.sessionId,
    includeFiles: input.includeFiles,
    allowExternalFiles: input.allowExternalFiles,
    includeConversation: input.includeConversation,
    includeDependencies: input.includeDependencies,
    includeDependents: input.includeDependents,
    includeTests: input.includeTests,
    includeTypes: input.includeTypes,
    maxTokens: input.maxTokens,
    prNumber: input.prNumber,
  });

  // Build egress summary (used for both dry run and actual execution)
  const summary = buildEgressSummary(bundle, input.projectPath, input.provider);

  // 2. If dry run, return preview without calling external API
  if (input.dryRun) {
    const hasWarnings = bundle.budgetWarnings.length > 0;
    return {
      dryRun: true,
      provider: input.provider,
      summary,
      totalTokens: bundle.totalTokens,
      budgetWarnings: bundle.budgetWarnings,
      message: hasWarnings
        ? `⚠️ ${bundle.budgetWarnings.length} budget warning(s) - some important files will be omitted`
        : "Ready to send",
    };
  }

  // 3. Check rate limit before calling external API
  const rateLimiter = getRateLimiter();
  const rateLimitStatus = rateLimiter.checkAndRecord();
  if (!rateLimitStatus.allowed) {
    const retryAfterSec = Math.ceil((rateLimitStatus.retryAfterMs || 0) / 1000);
    throw new Error(
      `Rate limited. Too many requests. Try again in ${retryAfterSec} seconds.`
    );
  }

  // 4. Format as markdown
  const contextMarkdown = formatBundleAsMarkdown(bundle, input.projectPath);

  // 5. Load review instructions
  const instructions = loadReviewInstructions(input.projectPath);

  // 6. Determine temperature (input > config > default)
  const temperature = input.temperature ?? config.temperature;

  // 7. Check if files were omitted due to budget (for system prompt calibration)
  const hasOmittedFiles = bundle.omittedFiles.some(
    (f) => f.reason === "budget_exceeded"
  );

  // 8. Create provider and execute task
  const provider = createProvider(input.provider as ProviderName, config);
  const response = await provider.review({
    instructions,
    context: contextMarkdown,
    task: input.task,
    focusAreas: input.focusAreas,
    customPrompt: input.customPrompt,
    temperature,
    hasOmittedFiles,
  });

  // 9. Derive session name if not provided
  const sessionName =
    input.sessionName ||
    deriveSessionName(bundle.conversationContext, "code-review");

  // 10. Write the output files
  const timestamp = new Date().toISOString();
  const metadata: ReviewMetadata = {
    sessionName,
    provider: input.provider,
    model: response.model,
    timestamp,
    filesReviewed: bundle.files.map((f) => f.path),
    tokensUsed: response.tokensUsed,
    task: input.task,
  };

  const reviewFile = writeReview(
    input.projectPath,
    config.reviewsDir,
    metadata,
    response.review
  );

  // 11. Write egress manifest for audit trail
  const egressManifestFile = writeEgressManifest(
    input.projectPath,
    config.reviewsDir,
    metadata,
    summary
  );

  return {
    dryRun: false,
    review: response.review,
    reviewFile,
    egressManifestFile,
    provider: input.provider,
    model: response.model,
    tokensUsed: response.tokensUsed,
    timestamp,
    filesReviewed: bundle.files.length,
    contextTokens: bundle.totalTokens,
    summary,
  };
}

// Re-export for testing
export { resetRateLimiter } from "../security/rate-limiter.js";
