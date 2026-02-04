import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { loadConfig, loadReviewInstructions } from "../config.js";
import { bundleContext, formatBundleAsMarkdown } from "../context/index.js";
import { createProvider, ProviderName } from "../providers/index.js";
import {
  writeReview,
  deriveSessionName,
  ReviewMetadata,
} from "../output/writer.js";

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
  provider: z.enum(["gemini", "openai"]).describe("Which LLM to use for the review"),
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
});

export type SecondOpinionInput = z.infer<typeof SecondOpinionInputSchema>;

export interface SecondOpinionOutput {
  review: string;
  reviewFile: string;
  provider: string;
  model: string;
  tokensUsed?: number;
  timestamp: string;
  filesReviewed: number;
  contextTokens: number;
}

export async function executeReview(
  input: SecondOpinionInput
): Promise<SecondOpinionOutput> {
  // Validate project path before proceeding
  validateProjectPath(input.projectPath);

  const config = loadConfig();

  // 1. Bundle the context
  const bundle = await bundleContext({
    projectPath: input.projectPath,
    sessionId: input.sessionId,
    includeFiles: input.includeFiles,
    includeConversation: input.includeConversation,
    includeDependencies: input.includeDependencies,
    includeDependents: input.includeDependents,
    includeTests: input.includeTests,
    includeTypes: input.includeTypes,
    maxTokens: input.maxTokens,
  });

  // 2. Format as markdown
  const contextMarkdown = formatBundleAsMarkdown(bundle, input.projectPath);

  // 3. Load review instructions
  const instructions = loadReviewInstructions(input.projectPath);

  // 4. Create provider and execute task
  const provider = createProvider(input.provider as ProviderName, config);
  const response = await provider.review({
    instructions,
    context: contextMarkdown,
    task: input.task,
    focusAreas: input.focusAreas,
    customPrompt: input.customPrompt,
  });

  // 5. Derive session name if not provided
  const sessionName =
    input.sessionName ||
    deriveSessionName(bundle.conversationContext, "code-review");

  // 6. Write the output to file
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

  return {
    review: response.review,
    reviewFile,
    provider: input.provider,
    model: response.model,
    tokensUsed: response.tokensUsed,
    timestamp,
    filesReviewed: bundle.files.length,
    contextTokens: bundle.totalTokens,
  };
}
