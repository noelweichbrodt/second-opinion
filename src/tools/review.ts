import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { loadConfig, loadReviewInstructions } from "../config.js";
import {
  bundleContext,
  formatBundleAsMarkdown,
  ContextBundle,
  BudgetWarning,
} from "../context/index.js";
import { isWithinProject } from "../context/imports.js";
import {
  CODEX_REVIEW_PLACEHOLDER,
  CodexHandoff,
  ConsensusResult,
  ProviderName,
  ReviewRequest,
  composeCodexPrompt,
  createCodexRescueCommand,
  createProvider,
  getConsensusReview,
} from "../providers/index.js";
import {
  writeReview,
  writePromptFile,
  writeEgressManifest,
  deriveSessionName,
  ReviewMetadata,
  EgressSummary,
} from "../output/writer.js";
import { formatConsensusOutput } from "../output/consensus-formatter.js";
import { getRateLimiter } from "../security/rate-limiter.js";
import {
  detectDominantLanguage,
  getLanguageHints,
} from "../utils/language.js";

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
    .enum(["gemini", "codex", "consensus", "openai"])
    .transform(
      (provider): ProviderName => provider === "openai" ? "codex" : provider
    )
    .describe(
      "codex = /codex:rescue handoff; consensus = Gemini + Codex handoff; 'openai' is a deprecated alias for 'codex'"
    ),
  projectPath: z.string().describe("Absolute project path"),

  // Task specification
  task: z
    .string()
    .optional()
    .describe("Replacement deliverable; omit for a standard code review"),

  // Context options
  sessionId: z
    .string()
    .optional()
    .describe("Session ID (default: most recent)"),
  includeFiles: z
    .array(z.string())
    .optional()
    .describe("Additional files/folders (~ and relative paths ok)"),
  allowExternalFiles: z
    .boolean()
    .default(false)
    .describe("Permit includeFiles paths outside the project"),
  includeConversation: z
    .boolean()
    .default(true)
    .describe("Include Claude session conversation"),

  // Smart context options
  includeDependencies: z
    .boolean()
    .default(true)
    .describe("Include imported dependencies"),
  includeDependents: z
    .boolean()
    .default(true)
    .describe("Include dependent files"),
  includeTests: z.boolean().default(true).describe("Include related tests"),
  includeTypes: z
    .boolean()
    .default(true)
    .describe("Include type definitions"),
  maxInputTokens: z
    .number()
    .optional()
    .describe("Max context tokens (default MAX_CONTEXT_TOKENS, 200000)"),
  maxOutputTokens: z
    .number()
    .optional()
    .describe("Max Gemini response tokens (default 32768); ignored for codex"),

  // PR options
  prNumber: z
    .number()
    .optional()
    .describe("PR number (default: auto-detect from branch)"),

  // LLM options
  temperature: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Gemini-only temperature 0-1 (default 0.3); ignored for codex"),

  // Output options
  sessionName: z.string().optional().describe("Output filename stem"),
  customPrompt: z
    .string()
    .optional()
    .describe("Deprecated — use task instead"),
  focusAreas: z
    .array(z.string())
    .optional()
    .describe("Review focus areas"),
  dryRun: z
    .boolean()
    .default(false)
    .describe("Preview the egress bundle without calling any provider"),
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
  /** Present when PR detection failed (e.g. gh not installed) */
  prDetectionFailure?: { reason: string; message: string };
}

export interface SecondOpinionOutput {
  dryRun?: false;
  handoff?: false;
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
  /** Budget reductions (omitted files, distilled conversation) the caller should know about. */
  budgetWarnings: BudgetWarning[];
  /** Present when PR detection failed (e.g. gh not installed) */
  prDetectionFailure?: { reason: string; message: string };
}

export interface SecondOpinionHandoffOutput extends CodexHandoff {
  dryRun?: false;
  handoff: true;
  provider: "codex" | "consensus";
  filesReviewed: number;
  contextTokens: number;
  summary: EgressSummary;
  /** Budget reductions (omitted files, distilled conversation) the caller should know about. */
  budgetWarnings: BudgetWarning[];
  /** Gemini's in-process result when this is a consensus handoff. */
  gemini?: ConsensusResult["gemini"];
  /** Present when PR detection failed (e.g. gh not installed) */
  prDetectionFailure?: { reason: string; message: string };
}

export type SecondOpinionResult =
  | SecondOpinionOutput
  | SecondOpinionHandoffOutput
  | SecondOpinionDryRunOutput;

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

function checkGeminiRateLimit(): string | null {
  const rateLimitStatus = getRateLimiter().checkAndRecord();
  if (!rateLimitStatus.allowed) {
    const retryAfterSec = Math.ceil(
      (rateLimitStatus.retryAfterMs || 0) / 1000
    );
    return `Rate limited. Too many requests. Try again in ${retryAfterSec} seconds.`;
  }
  return null;
}

function enforceGeminiRateLimit(): void {
  const error = checkGeminiRateLimit();
  if (error) {
    throw new Error(error);
  }
}

/**
 * POSIX single-quoting for Bash-executed helper commands: project paths may
 * contain spaces or `$`, and unlike rescueCommand (which a slash-command
 * forwarder consumes) these commands are run through a shell.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Absolute path to a compiled helper CLI next to this module. Commands embed
 * the dist/*.js path because the MCP server runs from dist. Placeholder
 * tokens (e.g. JOB_ID) must stay metacharacter-free and unquoted.
 */
function helperCommand(script: string, quotedArgs: string[]): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const helperPath = path
    .join(moduleDir, "..", "output", script)
    .replace(/\.ts$/, ".js");
  return ["node", shellQuote(helperPath), ...quotedArgs].join(" ");
}

function writeCodexHandoff(
  projectPath: string,
  reviewsDir: string,
  metadata: ReviewMetadata,
  summary: EgressSummary,
  prompt: string,
  codexModel: string
): CodexHandoff {
  const promptFile = writePromptFile(
    projectPath,
    reviewsDir,
    metadata,
    prompt
  );
  const rescueCommand = createCodexRescueCommand(
    promptFile,
    codexModel,
    Boolean(metadata.task)
  );
  const placeholderBody = [
    "## Codex Review",
    "",
    "Run the handoff command below, then replace the placeholder with Codex's verbatim final response.",
    "",
    "```text",
    rescueCommand,
    "```",
    "",
    CODEX_REVIEW_PLACEHOLDER,
  ].join("\n");
  const reviewFile = writeReview(
    projectPath,
    reviewsDir,
    metadata,
    placeholderBody
  );
  const egressManifestFile = writeEgressManifest(
    projectPath,
    reviewsDir,
    metadata,
    summary
  );

  return {
    promptFile,
    reviewFile,
    egressManifestFile,
    rescueCommand,
    verifyCommand: helperCommand("verify-review.js", [shellQuote(reviewFile)]),
    // --expect binds the splice to THIS handoff: a later handoff reusing the
    // sessionName regenerates the same reviewFile path, and without the
    // binding an older job's output would silently land in the new document.
    spliceCommand: helperCommand("splice-codex-result.js", [
      "JOB_ID",
      "--expect",
      shellQuote(metadata.timestamp),
      shellQuote(reviewFile),
    ]),
    model: codexModel,
  };
}

export async function executeReview(
  input: SecondOpinionInput
): Promise<SecondOpinionResult> {
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
    // Input wins, then MAX_CONTEXT_TOKENS config (default 200000). The zod
    // input default used to shadow the config value entirely.
    maxTokens: input.maxInputTokens ?? config.maxContextTokens,
    prNumber: input.prNumber,
  });

  // Consensus needs Gemini for its in-process half. Without a Gemini key it
  // degrades to the always-available Codex handoff.
  const effectiveProvider: ProviderName =
    input.provider === "consensus" && !config.geminiApiKey
      ? "codex"
      : input.provider;

  // Build egress summary (used for both dry run and actual execution)
  const summary = buildEgressSummary(bundle, input.projectPath, effectiveProvider);

  // 2. If dry run, return preview without calling external API
  if (input.dryRun) {
    const hasWarnings = bundle.budgetWarnings.length > 0;
    return {
      dryRun: true,
      provider: effectiveProvider,
      summary,
      totalTokens: bundle.totalTokens,
      budgetWarnings: bundle.budgetWarnings,
      message: hasWarnings
        ? `⚠️ ${bundle.budgetWarnings.length} budget warning(s) - some important files will be omitted`
        : "Ready to send",
      prDetectionFailure: bundle.prDetectionFailure,
    };
  }

  // 3. Format as markdown
  const contextMarkdown = formatBundleAsMarkdown(bundle, input.projectPath);

  // 4. Load review instructions. Replacement tasks (input.task) get a
  // self-contained task prompt: the review methodology and language pitfall
  // hints are review apparatus and are not sent with non-review deliverables.
  const instructions = input.task
    ? ""
    : loadReviewInstructions(input.projectPath);

  // 5. Determine Gemini generation options (input > config > default).
  // Codex receives neither temperature nor output-token CLI flags.
  const temperature = input.temperature ?? config.temperature;

  // 5a. Detect dominant language and get hints (review mode only)
  const dominantLang = input.task
    ? null
    : detectDominantLanguage(bundle.files.map((f) => f.path));
  const languageHints =
    dominantLang ? getLanguageHints(dominantLang) : undefined;

  // 6. Determine maxOutputTokens (input > config > default)
  const maxOutputTokens = input.maxOutputTokens ?? config.maxOutputTokens;

  const reviewRequest: ReviewRequest = {
    instructions,
    context: contextMarkdown,
    task: input.task,
    focusAreas: input.focusAreas,
    customPrompt: input.customPrompt,
    temperature,
    languageHints: languageHints || undefined,
    maxOutputTokens,
    branchDiff: bundle.branchDiff,
  };

  // 7. Derive session name if not provided
  const sessionName =
    input.sessionName ||
    deriveSessionName(bundle.conversationContext, "code-review");

  // 8. Prepare shared metadata
  const timestamp = new Date().toISOString();

  if (effectiveProvider === "codex") {
    const metadata: ReviewMetadata = {
      sessionName,
      provider: "codex",
      model: config.codexModel,
      timestamp,
      filesReviewed: bundle.files.map((f) => f.path),
      task: input.task,
    };
    const handoff = writeCodexHandoff(
      input.projectPath,
      config.reviewsDir,
      metadata,
      summary,
      composeCodexPrompt(reviewRequest),
      config.codexModel
    );

    return {
      dryRun: false,
      handoff: true,
      provider: "codex",
      ...handoff,
      filesReviewed: bundle.files.length,
      contextTokens: bundle.totalTokens,
      summary,
      budgetWarnings: bundle.budgetWarnings,
      prDetectionFailure: bundle.prDetectionFailure,
    };
  }

  if (effectiveProvider === "consensus") {
    const metadata: ReviewMetadata = {
      sessionName,
      provider: "consensus",
      model: `Gemini ${config.geminiModel} + Codex ${config.codexModel}`,
      timestamp,
      filesReviewed: bundle.files.map((f) => f.path),
      task: input.task,
    };
    // The Codex handoff consumes no Gemini quota, so it is written before the
    // rate-limit check; a quota trip degrades to gemini.error like any other
    // Gemini failure instead of destroying the handoff.
    const handoff = writeCodexHandoff(
      input.projectPath,
      config.reviewsDir,
      metadata,
      summary,
      composeCodexPrompt(reviewRequest),
      config.codexModel
    );
    const rateLimitError = checkGeminiRateLimit();
    const consensus = rateLimitError
      ? {
          gemini: {
            review: "",
            model: config.geminiModel,
            error: rateLimitError,
          },
          codex: handoff,
        }
      : await getConsensusReview(reviewRequest, config, handoff);
    // Two-phase write: writeCodexHandoff already wrote a Codex-only placeholder
    // body, which stays behind as a valid degraded file if the Gemini call
    // dies mid-flight; this overwrite upgrades it to the full consensus layout.
    writeReview(
      input.projectPath,
      config.reviewsDir,
      metadata,
      formatConsensusOutput(consensus, {
        task: input.task,
        sessionName,
      })
    );

    return {
      dryRun: false,
      handoff: true,
      provider: "consensus",
      ...handoff,
      filesReviewed: bundle.files.length,
      contextTokens: bundle.totalTokens,
      summary,
      budgetWarnings: bundle.budgetWarnings,
      gemini: consensus.gemini,
      prDetectionFailure: bundle.prDetectionFailure,
    };
  }

  const provider = createProvider("gemini", config);
  enforceGeminiRateLimit();
  const response = await provider.review(reviewRequest);

  const metadata: ReviewMetadata = {
    sessionName,
    provider: "gemini",
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

  // 9. Write egress manifest for audit trail
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
    provider: effectiveProvider,
    model: response.model,
    tokensUsed: response.tokensUsed,
    timestamp,
    filesReviewed: bundle.files.length,
    contextTokens: bundle.totalTokens,
    summary,
    budgetWarnings: bundle.budgetWarnings,
    prDetectionFailure: bundle.prDetectionFailure,
  };
}

// Re-export for testing
export { resetRateLimiter } from "../security/rate-limiter.js";
