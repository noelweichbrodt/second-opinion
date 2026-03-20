import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  parseSession,
  findLatestSession,
  formatConversationContext,
  SessionContext,
} from "./session.js";
import { getAllModifiedFiles, getFileDiff, getBranchDiff } from "./git.js";
import { detectPR, formatPRMetadata, PRContext, PRDetectionResult } from "./pr.js";
import {
  getDependencies,
  buildImportIndex,
  getDependentsFromIndex,
  isWithinProject,
} from "./imports.js";
import { findTestFilesForFiles } from "./tests.js";
import { findTypeFilesForFiles } from "./types.js";
import {
  estimateTokens,
  BUDGET_ALLOCATION,
  BudgetCategory,
  CATEGORY_PRIORITY_ORDER,
  FIXED_OVERHEAD_CAPS,
} from "../utils/tokens.js";
import { redactSecrets } from "../security/redactor.js";

/**
 * Split a unified diff into per-file sections.
 * Each section starts with "diff --git a/... b/..." and includes all hunks for that file.
 */
function splitDiffByFile(diff: string): Array<{ file: string; content: string }> {
  const sections: Array<{ file: string; content: string }> = [];
  const lines = diff.split("\n");
  let currentFile = "";
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      // Flush previous section
      if (currentFile && currentLines.length > 0) {
        sections.push({ file: currentFile, content: currentLines.join("\n") });
      }
      // Extract filename from "diff --git a/path b/path"
      // Git quotes paths with spaces: diff --git "a/path with spaces" "b/path with spaces"
      const match = line.match(/^diff --git "?a\/(.+?)"? "?b\//)
        || line.match(/^diff --git a\/(.+) b\//);
      currentFile = match ? match[1] : "unknown";
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  // Flush last section
  if (currentFile && currentLines.length > 0) {
    sections.push({ file: currentFile, content: currentLines.join("\n") });
  }

  return sections;
}

/**
 * Expand tilde in paths to home directory
 */
function expandTilde(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Sensitive paths that should never be included, even when explicitly requested
 */
const SENSITIVE_PATH_PATTERNS = [
  // Version control
  /[/\\]\.git[/\\]?/i,

  // SSH and encryption keys
  /[/\\]\.ssh[/\\]?/i,
  /[/\\]\.gnupg[/\\]?/i,
  /[/\\]\.gpg[/\\]?/i,
  /[/\\]id_rsa/i,
  /[/\\]id_ed25519/i,
  /[/\\]id_ecdsa/i,
  /[/\\]\.pem$/i,
  /[/\\]\.key$/i,

  // Cloud provider configs
  /[/\\]\.aws[/\\]?/i,
  /[/\\]\.config[/\\](?:gcloud|gh|hub)[/\\]?/i,
  /[/\\]\.kube[/\\]?/i,
  /[/\\]\.docker[/\\]config\.json$/i,

  // Package manager auth
  /[/\\]\.netrc$/i,
  /[/\\]\.npmrc$/i,
  /[/\\]\.pypirc$/i,

  // Credential files
  /[/\\]credentials\.json$/i,
  /[/\\]service[-_]?account.*\.json$/i,
  /[/\\]\.credentials$/i,
  /secrets\.(json|ya?ml)$/i,

  // Environment files (commonly contain secrets)
  /[/\\]\.env($|\.[^/\\]*$)/i, // .env, .env.local, .env.production, etc.

  // Terraform/IaC secrets
  /\.tfvars$/i,
  /terraform\.tfstate/i,

  // Kubernetes secrets
  /secret\.ya?ml$/i,

  // Shell history (may contain commands with secrets)
  /\.(bash|zsh|sh)_history$/i,
];

/**
 * Check if a path points to a sensitive location
 */
function isSensitivePath(filePath: string): boolean {
  const normalized = path.normalize(filePath);
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export interface BlockedFile {
  path: string;
  reason: "sensitive_path" | "outside_project_requires_allowExternalFiles";
}

/** Maximum directory recursion depth to prevent stack overflow from deep/circular structures */
const MAX_EXPAND_DEPTH = 10;

/**
 * Expand a path to a list of files (handles directories recursively)
 * Returns object with files and any blocked paths
 */
function expandPath(
  inputPath: string,
  projectPath: string,
  options?: { allowExternalFiles?: boolean },
  depth: number = 0
): { files: string[]; blocked: BlockedFile[] } {
  const result = { files: [] as string[], blocked: [] as BlockedFile[] };

  // Guard against excessively deep directory structures
  if (depth >= MAX_EXPAND_DEPTH) {
    return result;
  }

  // Expand tilde
  let expandedPath = expandTilde(inputPath);

  // Make relative paths absolute (relative to project)
  if (!path.isAbsolute(expandedPath)) {
    expandedPath = path.join(projectPath, expandedPath);
  }

  // Normalize the path
  expandedPath = path.normalize(expandedPath);

  // Block sensitive paths
  if (isSensitivePath(expandedPath)) {
    result.blocked.push({ path: expandedPath, reason: "sensitive_path" });
    return result;
  }

  if (!fs.existsSync(expandedPath)) {
    return result;
  }

  // Resolve symlinks to prevent escaping to sensitive locations
  let realPath: string;
  try {
    realPath = fs.realpathSync(expandedPath);
  } catch {
    // Can't resolve path, skip it
    return result;
  }

  // Check the resolved path against sensitive patterns
  if (isSensitivePath(realPath)) {
    result.blocked.push({ path: expandedPath, reason: "sensitive_path" });
    return result;
  }

  // Check if file is outside project bounds (unless allowExternalFiles is true)
  if (!options?.allowExternalFiles && !isWithinProject(realPath, projectPath)) {
    result.blocked.push({
      path: expandedPath,
      reason: "outside_project_requires_allowExternalFiles",
    });
    return result;
  }

  const stat = fs.statSync(realPath);
  if (stat.isFile()) {
    result.files.push(realPath);
    return result;
  }

  if (stat.isDirectory()) {
    const entries = fs.readdirSync(realPath, { withFileTypes: true });
    for (const entry of entries) {
      // Skip hidden files and common non-code directories
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const fullPath = path.join(realPath, entry.name);

      // Resolve symlinks for each entry
      let entryRealPath: string;
      try {
        entryRealPath = fs.realpathSync(fullPath);
      } catch {
        continue;
      }

      // Check resolved path for sensitivity
      if (isSensitivePath(entryRealPath)) {
        result.blocked.push({ path: fullPath, reason: "sensitive_path" });
        continue;
      }

      // Check project bounds for entries too
      if (
        !options?.allowExternalFiles &&
        !isWithinProject(entryRealPath, projectPath)
      ) {
        result.blocked.push({
          path: fullPath,
          reason: "outside_project_requires_allowExternalFiles",
        });
        continue;
      }

      const entryStat = fs.statSync(entryRealPath);
      if (entryStat.isFile()) {
        result.files.push(entryRealPath);
      } else if (entryStat.isDirectory()) {
        // Recursively expand subdirectories
        const subResult = expandPath(entryRealPath, projectPath, options, depth + 1);
        result.files.push(...subResult.files);
        result.blocked.push(...subResult.blocked);
      }
    }
  }

  return result;
}

export interface BundleOptions {
  projectPath: string;
  sessionId?: string;
  includeConversation?: boolean;
  includeDependencies?: boolean;
  includeDependents?: boolean;
  includeTests?: boolean;
  includeTypes?: boolean;
  includeFiles?: string[];
  allowExternalFiles?: boolean;
  maxTokens?: number;
  prNumber?: number;
}

export interface FileEntry {
  path: string;
  content: string;
  category:
    | "session"
    | "pr"
    | "git"
    | "dependency"
    | "dependent"
    | "test"
    | "type"
    | "explicit";
  tokenEstimate: number;
  /** Why this file is included (e.g., "Imported by src/foo.ts"). Rendered in context markdown. */
  annotation?: string;
}

export interface OmittedFile {
  path: string;
  category: FileEntry["category"];
  tokenEstimate: number;
  reason:
    | "budget_exceeded"
    | "outside_project"
    | "sensitive_path"
    | "outside_project_requires_allowExternalFiles";
}

export interface BudgetWarning {
  severity: "high" | "medium" | "low";
  category: FileEntry["category"];
  omittedCount: number;
  omittedTokens: number;
  message: string;
  suggestedBudget?: number;
}

export interface ContextBundle {
  conversationContext: string;
  /** Formatted PR metadata markdown (title, body, comments, reviews) */
  prContext?: string;
  /** Raw PR metadata for structured access (egress summary, etc.) */
  prMetadata?: { number: number; url: string; commentsCount: number; reviewsCount: number };
  /** Unified diff of branch changes (from base branch), kept separate from file markdown */
  branchDiff?: string;
  files: FileEntry[];
  omittedFiles: OmittedFile[];
  totalTokens: number;
  categories: {
    session: number;
    pr: number;
    git: number;
    dependency: number;
    dependent: number;
    test: number;
    type: number;
    explicit: number;
  };
  /** Statistics about secrets redacted from file contents */
  redactionStats: {
    totalCount: number;
    types: string[];
  };
  /** Warnings about high-priority files being omitted due to budget */
  budgetWarnings: BudgetWarning[];
  /** Set when PR detection failed for a non-trivial reason (not "no PR found") */
  prDetectionFailure?: { reason: string; message: string };
}

interface ReadFileResult {
  entry: FileEntry | null;
  redactionCount: number;
  redactedTypes: string[];
}

/**
 * Read a file, redact any secrets, and create a FileEntry
 */
function readFileEntry(
  filePath: string,
  category: FileEntry["category"],
  existingContent?: string
): ReadFileResult {
  try {
    const rawContent = existingContent || fs.readFileSync(filePath, "utf-8");

    // Redact secrets before including in bundle
    const redactionResult = redactSecrets(rawContent);

    return {
      entry: {
        path: filePath,
        content: redactionResult.content,
        category,
        tokenEstimate: estimateTokens(redactionResult.content),
      },
      redactionCount: redactionResult.redactionCount,
      redactedTypes: redactionResult.redactedTypes,
    };
  } catch {
    return { entry: null, redactionCount: 0, redactedTypes: [] };
  }
}

export interface CandidateFile {
  path: string;
  content: string;
  category: FileEntry["category"];
  tokenEstimate: number;
  annotation?: string;
  redactionCount: number;
  redactedTypes: string[];
}

function toFileEntry(file: CandidateFile): FileEntry {
  return {
    path: file.path,
    content: file.content,
    category: file.category,
    tokenEstimate: file.tokenEstimate,
    annotation: file.annotation,
  };
}

/**
 * Check if a path is sensitive and add to omitted list if so. Returns true if blocked.
 */
function omitIfSensitive(
  filePath: string,
  category: FileEntry["category"],
  omittedFiles: OmittedFile[]
): boolean {
  if (isSensitivePath(path.normalize(filePath))) {
    omittedFiles.push({ path: filePath, category, tokenEstimate: 0, reason: "sensitive_path" });
    return true;
  }
  return false;
}

export interface CategoryCandidates {
  category: BudgetCategory;
  files: CandidateFile[];
  totalDemand: number;
}

export interface AllocationResult {
  included: FileEntry[];
  omitted: OmittedFile[];
  categoryTokens: Record<BudgetCategory, number>;
}

/**
 * Two-pass budget allocator.
 *
 * If total demand <= filePool, include everything (common case, fixes the original bug).
 * If total demand > filePool, redistribute surplus from low-demand categories to high-demand ones.
 *
 * Within each category:
 * - explicit/session: preserve insertion order (user intent)
 * - all others: sort smallest first (maximize file count)
 */
export function allocateBudget(
  candidates: CategoryCandidates[],
  filePool: number,
  budgetWeights: Record<BudgetCategory, number>,
  priorityOrder: BudgetCategory[]
): AllocationResult {
  const included: FileEntry[] = [];
  // Internal omitted list stores full candidates so rescued files can be promoted
  const omitted: CandidateFile[] = [];
  let totalUsed = 0;
  const categoryTokens = Object.fromEntries(
    priorityOrder.map((cat) => [cat, 0])
  ) as Record<BudgetCategory, number>;

  const totalDemand = candidates.reduce((sum, c) => sum + c.totalDemand, 0);

  // Fast path: everything fits
  if (totalDemand <= filePool) {
    for (const { category, files } of candidates) {
      for (const file of files) {
        included.push(toFileEntry(file));
        categoryTokens[category] += file.tokenEstimate;
      }
    }
    return { included, omitted: [], categoryTokens };
  }

  // Contention path: surplus redistribution
  const demandMap = new Map<BudgetCategory, number>();
  const candidateMap = new Map<BudgetCategory, CandidateFile[]>();
  for (const { category, files, totalDemand: d } of candidates) {
    demandMap.set(category, d);
    candidateMap.set(category, files);
  }

  // Compute effective allocations via iterative surplus redistribution.
  // All categories participate (even empty ones) so their unused base allocation
  // is available as surplus for categories with demand.
  const effectiveAlloc = new Map<BudgetCategory, number>();

  // Initialize base allocations for ALL categories
  for (const cat of priorityOrder) {
    effectiveAlloc.set(cat, filePool * (budgetWeights[cat] ?? 0));
  }

  // Up to 3 rounds of redistribution
  for (let round = 0; round < 3; round++) {
    let totalSurplus = 0;
    let totalDeficit = 0;
    const surplusCats: BudgetCategory[] = [];
    const deficitCats: BudgetCategory[] = [];

    for (const cat of priorityOrder) {
      const demand = demandMap.get(cat) ?? 0;
      const alloc = effectiveAlloc.get(cat) ?? 0;
      if (demand <= alloc) {
        totalSurplus += alloc - demand;
        surplusCats.push(cat);
      } else {
        totalDeficit += demand - alloc;
        deficitCats.push(cat);
      }
    }

    if (totalSurplus === 0 || totalDeficit === 0) break;

    // Set surplus categories to their demand, distribute surplus to deficit categories
    for (const cat of surplusCats) {
      effectiveAlloc.set(cat, demandMap.get(cat) ?? 0);
    }
    for (const cat of deficitCats) {
      const alloc = effectiveAlloc.get(cat) ?? 0;
      const deficit = (demandMap.get(cat) ?? 0) - alloc;
      effectiveAlloc.set(cat, alloc + totalSurplus * (deficit / totalDeficit));
    }
  }

  // Select files within each category's effective allocation
  for (const cat of priorityOrder) {
    const files = candidateMap.get(cat);
    if (!files || files.length === 0) continue;

    const budget = effectiveAlloc.get(cat) ?? 0;

    // Sort: explicit/session preserve insertion order, others smallest-first
    const sorted = cat === "explicit" || cat === "session"
      ? files
      : [...files].sort((a, b) => a.tokenEstimate - b.tokenEstimate);

    let used = 0;
    for (const file of sorted) {
      if (used + file.tokenEstimate <= budget) {
        included.push(toFileEntry(file));
        categoryTokens[cat] += file.tokenEstimate;
        used += file.tokenEstimate;
        totalUsed += file.tokenEstimate;
      } else {
        omitted.push(file);
      }
    }
  }

  // Global remainder fill: rescue omitted files that fit in unused global budget.
  // This handles the edge case where a file exceeds its category's effective
  // allocation but would fit in the overall pool.
  let globalRemaining = filePool - totalUsed;

  if (globalRemaining > 0 && omitted.length > 0) {
    const sorted = [...omitted].sort((a, b) => {
      const priA = priorityOrder.indexOf(a.category as BudgetCategory);
      const priB = priorityOrder.indexOf(b.category as BudgetCategory);
      if (priA !== priB) return priA - priB;
      return a.tokenEstimate - b.tokenEstimate;
    });

    const rescued = new Set<CandidateFile>();
    for (const file of sorted) {
      if (file.tokenEstimate <= globalRemaining) {
        included.push(toFileEntry(file));
        categoryTokens[file.category as BudgetCategory] += file.tokenEstimate;
        globalRemaining -= file.tokenEstimate;
        rescued.add(file);
      }
    }

    if (rescued.size > 0) {
      const finalOmitted = omitted.filter((f) => !rescued.has(f));
      return {
        included,
        omitted: finalOmitted.map((f) => ({
          path: f.path, category: f.category, tokenEstimate: f.tokenEstimate, reason: "budget_exceeded" as const,
        })),
        categoryTokens,
      };
    }
  }

  return {
    included,
    omitted: omitted.map((f) => ({
      path: f.path, category: f.category, tokenEstimate: f.tokenEstimate, reason: "budget_exceeded" as const,
    })),
    categoryTokens,
  };
}

/**
 * Convert a ReadFileResult into a CandidateFile (returns null if the file couldn't be read)
 */
function toCandidateFile(result: ReadFileResult): CandidateFile | null {
  if (!result.entry) return null;
  return {
    path: result.entry.path,
    content: result.entry.content,
    category: result.entry.category,
    tokenEstimate: result.entry.tokenEstimate,
    annotation: result.entry.annotation,
    redactionCount: result.redactionCount,
    redactedTypes: result.redactedTypes,
  };
}

/**
 * Collect and bundle all context for review.
 *
 * Two-pass architecture:
 *   Pass 1 (Collection): Gather all candidate files per category without committing budget.
 *   Deduplication: Assign each file to its highest-priority category.
 *   Pass 2 (Allocation): Distribute the file pool across categories via allocateBudget().
 */
export async function bundleContext(
  options: BundleOptions
): Promise<ContextBundle> {
  const {
    projectPath,
    sessionId,
    includeConversation = true,
    includeDependencies = true,
    includeDependents = true,
    includeTests = true,
    includeTypes = true,
    includeFiles = [],
    allowExternalFiles = false,
    maxTokens = 100000,
    prNumber,
  } = options;

  const bundle: ContextBundle = {
    conversationContext: "",
    files: [],
    omittedFiles: [],
    totalTokens: 0,
    categories: {
      session: 0,
      pr: 0,
      git: 0,
      dependency: 0,
      dependent: 0,
      test: 0,
      type: 0,
      explicit: 0,
    },
    redactionStats: {
      totalCount: 0,
      types: [],
    },
    budgetWarnings: [],
  };

  const allRedactedTypes = new Set<string>();

  // ─── Fixed overhead: conversation context ───
  let sessionContext: SessionContext | null = null;
  const sid = sessionId || findLatestSession(projectPath);
  if (sid) {
    sessionContext = parseSession(projectPath, sid);
  }

  let conversationTokens = 0;
  if (includeConversation && sessionContext) {
    bundle.conversationContext = formatConversationContext(sessionContext);
    conversationTokens = estimateTokens(bundle.conversationContext);
  }

  // ─── Fixed overhead: PR metadata ───
  let prMetadataTokens = 0;
  const prDetection = detectPR(projectPath, prNumber);
  if (prDetection.ok) {
    const prContext = prDetection.pr;
    const prMetadata = formatPRMetadata(prContext);
    prMetadataTokens = estimateTokens(prMetadata);
    bundle.prContext = prMetadata;
    bundle.prMetadata = {
      number: prContext.number,
      url: prContext.url,
      commentsCount: prContext.comments.length,
      reviewsCount: prContext.reviews.length,
    };
  } else if (prDetection.reason !== "no_pr_found") {
    bundle.prDetectionFailure = { reason: prDetection.reason, message: prDetection.message };
  }

  // ─── Fixed overhead: branch diff ───
  const prBaseBranch = prDetection.ok ? prDetection.pr.baseBranch : undefined;
  const rawDiff = getBranchDiff(projectPath, prBaseBranch);
  let branchDiffTokens = 0;
  if (rawDiff) {
    const diffTokens = estimateTokens(rawDiff);
    const remainingForDiffCap = maxTokens - conversationTokens - prMetadataTokens;
    const diffCap = Math.min(
      Math.floor(remainingForDiffCap * FIXED_OVERHEAD_CAPS.branchDiffFraction),
      FIXED_OVERHEAD_CAPS.branchDiffAbsoluteMax
    );

    if (diffTokens <= diffCap) {
      bundle.branchDiff = rawDiff;
      branchDiffTokens = diffTokens;
    } else {
      // Hunk-aware truncation: keep complete per-file diffs, drop later files
      const fileHunks = splitDiffByFile(rawDiff);
      const includedHunks: string[] = [];
      const omittedDiffFiles: string[] = [];
      let usedTokens = 0;
      for (const hunk of fileHunks) {
        const hunkTokens = estimateTokens(hunk.content);
        if (usedTokens + hunkTokens <= diffCap - 100) {
          includedHunks.push(hunk.content);
          usedTokens += hunkTokens;
        } else {
          omittedDiffFiles.push(hunk.file);
        }
      }
      if (includedHunks.length > 0) {
        let truncated = includedHunks.join("\n");
        if (omittedDiffFiles.length > 0) {
          truncated += "\n\n[... diff truncated — " + omittedDiffFiles.length
            + " file(s) omitted: " + omittedDiffFiles.join(", ") + " ...]";
        }
        bundle.branchDiff = truncated;
        branchDiffTokens = estimateTokens(truncated);
      }
    }
  }

  // ─── Compute file pool ───
  const filePool = Math.max(0, maxTokens - conversationTokens - prMetadataTokens - branchDiffTokens);
  bundle.totalTokens = conversationTokens + prMetadataTokens + branchDiffTokens;

  // ═══════════════════════════════════════════════
  // PASS 1: Collect all candidates per category
  // ═══════════════════════════════════════════════

  const candidateMap = new Map<BudgetCategory, CandidateFile[]>();
  for (const cat of CATEGORY_PRIORITY_ORDER) {
    candidateMap.set(cat, []);
  }

  // Track paths we've seen (for cross-category dedup and dependency discovery)
  const seenPaths = new Set<string>();
  const modifiedFiles: string[] = [];

  // 1. Explicit files
  if (includeFiles.length > 0) {
    for (const inputPath of includeFiles) {
      const { files: expandedPaths, blocked } = expandPath(inputPath, projectPath, {
        allowExternalFiles,
      });

      for (const blockedFile of blocked) {
        bundle.omittedFiles.push({
          path: blockedFile.path,
          category: "explicit",
          tokenEstimate: 0,
          reason: blockedFile.reason,
        });
      }

      for (const filePath of expandedPaths) {
        if (seenPaths.has(filePath)) continue;
        const result = readFileEntry(filePath, "explicit");
        const candidate = toCandidateFile(result);
        if (candidate) {
          candidateMap.get("explicit")!.push(candidate);

          seenPaths.add(filePath);
        }
      }
    }
  }

  // 2. Session files
  if (sessionContext) {
    const sessionAnnotations = new Map<string, string>();
    for (const filePath of sessionContext.filesRead) {
      sessionAnnotations.set(filePath, "Read during session");
    }
    for (const filePath of sessionContext.filesEdited) {
      sessionAnnotations.set(filePath, "Edited in session");
    }
    for (const filePath of sessionContext.filesWritten) {
      sessionAnnotations.set(filePath, "Modified in session");
    }

    const allSessionFiles = [
      ...sessionContext.filesWritten,
      ...sessionContext.filesEdited,
      ...sessionContext.filesRead,
    ];

    for (const filePath of allSessionFiles) {
      if (seenPaths.has(filePath)) continue;
      if (omitIfSensitive(filePath, "session", bundle.omittedFiles)) continue;
      const cachedContent = sessionContext.fileContents.get(filePath);
      const result = readFileEntry(filePath, "session", cachedContent);
      const candidate = toCandidateFile(result);
      if (candidate) {
        candidate.annotation = sessionAnnotations.get(filePath);
        candidateMap.get("session")!.push(candidate);

        seenPaths.add(filePath);
        if (
          sessionContext.filesWritten.includes(filePath) ||
          sessionContext.filesEdited.includes(filePath)
        ) {
          modifiedFiles.push(filePath);
        }
      }
    }
  }

  // 3. PR changed files
  if (prDetection.ok) {
    const prContext = prDetection.pr;
    for (const filePath of prContext.changedFiles) {
      if (seenPaths.has(filePath)) continue;

      if (omitIfSensitive(filePath, "pr", bundle.omittedFiles)) continue;
      if (!isWithinProject(path.normalize(filePath), projectPath)) {
        bundle.omittedFiles.push({ path: filePath, category: "pr", tokenEstimate: 0, reason: "outside_project" });
        continue;
      }

      const result = readFileEntry(filePath, "pr");
      const candidate = toCandidateFile(result);
      if (candidate) {
        candidate.annotation = `Changed in PR #${prContext.number}`;
        candidateMap.get("pr")!.push(candidate);

        seenPaths.add(filePath);
        modifiedFiles.push(filePath);
      }
    }
  }

  // 4. Git changes not in session
  const gitChangedFiles = getAllModifiedFiles(projectPath);
  for (const filePath of gitChangedFiles) {
    if (seenPaths.has(filePath)) continue;
    if (omitIfSensitive(filePath, "git", bundle.omittedFiles)) continue;
    const result = readFileEntry(filePath, "git");
    const candidate = toCandidateFile(result);
    if (candidate) {
      candidate.annotation = "Uncommitted changes";
      candidateMap.get("git")!.push(candidate);
      seenPaths.add(filePath);
      modifiedFiles.push(filePath);
    }
  }

  // 5. Dependencies
  if (includeDependencies && modifiedFiles.length > 0) {
    const depImporterMap = new Map<string, string[]>();
    for (const modFile of modifiedFiles) {
      const deps = getDependencies(modFile, projectPath);
      for (const dep of deps) {
        if (!modifiedFiles.includes(dep)) {
          if (!depImporterMap.has(dep)) depImporterMap.set(dep, []);
          depImporterMap.get(dep)!.push(modFile);
        }
      }
    }

    for (const [dep, importers] of depImporterMap) {
      if (seenPaths.has(dep)) continue;
      if (omitIfSensitive(dep, "dependency", bundle.omittedFiles)) continue;
      const result = readFileEntry(dep, "dependency");
      const candidate = toCandidateFile(result);
      if (candidate) {
        // Bounds check for auto-discovered files
        if (!isWithinProject(dep, projectPath)) {
          bundle.omittedFiles.push({
            path: dep,
            category: "dependency",
            tokenEstimate: candidate.tokenEstimate,
            reason: "outside_project",
          });
          continue;
        }
        const relImporters = importers.map((f) => path.relative(projectPath, f));
        candidate.annotation = `Imported by ${relImporters.join(", ")}`;
        candidateMap.get("dependency")!.push(candidate);

        seenPaths.add(dep);
      }
    }
  }

  // 6. Dependents
  if (includeDependents && modifiedFiles.length > 0) {
    const importIndex = await buildImportIndex(projectPath);
    const dependents = getDependentsFromIndex(modifiedFiles, importIndex);

    for (const dep of dependents) {
      if (seenPaths.has(dep)) continue;
      if (omitIfSensitive(dep, "dependent", bundle.omittedFiles)) continue;
      const result = readFileEntry(dep, "dependent");
      const candidate = toCandidateFile(result);
      if (candidate) {
        if (!isWithinProject(dep, projectPath)) {
          bundle.omittedFiles.push({
            path: dep,
            category: "dependent",
            tokenEstimate: candidate.tokenEstimate,
            reason: "outside_project",
          });
          continue;
        }
        const importsModified: string[] = [];
        for (const modFile of modifiedFiles) {
          if (importIndex.importedBy.get(modFile)?.has(dep)) {
            importsModified.push(path.relative(projectPath, modFile));
          }
        }
        if (importsModified.length > 0) {
          candidate.annotation = `Imports ${importsModified.join(", ")}`;
        }
        candidateMap.get("dependent")!.push(candidate);

        seenPaths.add(dep);
      }
    }
  }

  // 7. Test files
  if (includeTests && modifiedFiles.length > 0) {
    const tests = findTestFilesForFiles(modifiedFiles, projectPath);
    for (const test of tests) {
      if (seenPaths.has(test)) continue;
      if (omitIfSensitive(test, "test", bundle.omittedFiles)) continue;
      const result = readFileEntry(test, "test");
      const candidate = toCandidateFile(result);
      if (candidate) {
        candidateMap.get("test")!.push(candidate);

        seenPaths.add(test);
      }
    }
  }

  // 8. Type files
  if (includeTypes && modifiedFiles.length > 0) {
    const types = await findTypeFilesForFiles(modifiedFiles, projectPath);
    for (const typeFile of types) {
      if (seenPaths.has(typeFile)) continue;
      if (omitIfSensitive(typeFile, "type", bundle.omittedFiles)) continue;
      const result = readFileEntry(typeFile, "type");
      const candidate = toCandidateFile(result);
      if (candidate) {
        candidateMap.get("type")!.push(candidate);

        seenPaths.add(typeFile);
      }
    }
  }

  // ═══════════════════════════════════════════════
  // PASS 2: Allocate budget across categories
  // ═══════════════════════════════════════════════

  const categoryCandidates: CategoryCandidates[] = [];
  for (const cat of CATEGORY_PRIORITY_ORDER) {
    const files = candidateMap.get(cat) ?? [];
    if (files.length > 0) {
      categoryCandidates.push({
        category: cat,
        files,
        totalDemand: files.reduce((sum, f) => sum + f.tokenEstimate, 0),
      });
    }
  }

  const allocation = allocateBudget(
    categoryCandidates,
    filePool,
    BUDGET_ALLOCATION,
    CATEGORY_PRIORITY_ORDER
  );

  bundle.files = allocation.included;
  bundle.omittedFiles.push(...allocation.omitted);
  bundle.categories = allocation.categoryTokens;
  bundle.totalTokens += allocation.included.reduce((sum, f) => sum + f.tokenEstimate, 0);

  // Finalize redaction stats — only from included files (not omitted candidates)
  const candidateByPath = new Map<string, CandidateFile>();
  for (const [, files] of candidateMap) {
    for (const f of files) candidateByPath.set(f.path, f);
  }
  for (const included of allocation.included) {
    const candidate = candidateByPath.get(included.path);
    if (candidate) {
      bundle.redactionStats.totalCount += candidate.redactionCount;
      for (const type of candidate.redactedTypes) allRedactedTypes.add(type);
    }
  }
  bundle.redactionStats.types = Array.from(allRedactedTypes);

  // Generate budget warnings for high-priority file omissions
  const budgetOmissions = allocation.omitted.filter((f) => f.reason === "budget_exceeded");
  const categoryOmissions: Partial<
    Record<BudgetCategory, { count: number; tokens: number; files: string[] }>
  > = {};
  for (const omitted of budgetOmissions) {
    if (omitted.category === "explicit" || omitted.category === "session") {
      if (!categoryOmissions[omitted.category]) {
        categoryOmissions[omitted.category] = { count: 0, tokens: 0, files: [] };
      }
      categoryOmissions[omitted.category]!.count++;
      categoryOmissions[omitted.category]!.tokens += omitted.tokenEstimate;
      categoryOmissions[omitted.category]!.files.push(omitted.path);
    }
  }

  for (const [category, info] of Object.entries(categoryOmissions)) {
    if (info && info.count > 0) {
      const suggestedBudget =
        Math.ceil((maxTokens + info.tokens + 5000) / 10000) * 10000;
      bundle.budgetWarnings.push({
        severity: category === "explicit" ? "high" : "medium",
        category: category as FileEntry["category"],
        omittedCount: info.count,
        omittedTokens: info.tokens,
        message: `${info.count} ${category} file(s) (~${info.tokens.toLocaleString()} tokens) will be omitted`,
        suggestedBudget,
      });
    }
  }

  return bundle;
}

/**
 * Format a prominent warning banner when significant files are omitted
 */
function formatTruncationWarning(
  omittedFiles: OmittedFile[],
  omittedTokens: number
): string {
  const budgetOmitted = omittedFiles.filter((f) => f.reason === "budget_exceeded");
  return `> ⚠️ **INCOMPLETE CONTEXT WARNING**
>
> Due to token budget limits, ${budgetOmitted.length} files (~${omittedTokens.toLocaleString()} tokens) were omitted.
> Omitted files are listed at the end of this document.
>
> **Important:** Do not report issues in code you cannot see. If you suspect a problem
> but the relevant code is not visible, note it as "Unable to verify - code not in context"
> rather than flagging it as a bug.

`;
}

/**
 * Format the bundle as markdown for the reviewer
 */
export function formatBundleAsMarkdown(
  bundle: ContextBundle,
  projectPath: string
): string {
  const lines: string[] = [];

  // Add truncation warning at the TOP if significant files were omitted
  const budgetOmittedFiles = bundle.omittedFiles.filter(
    (f) => f.reason === "budget_exceeded"
  );
  const omittedTokens = budgetOmittedFiles.reduce(
    (sum, f) => sum + f.tokenEstimate,
    0
  );

  // Trigger warning if: ≥3 files omitted OR omitted tokens > 10% of total
  if (
    budgetOmittedFiles.length >= 3 ||
    omittedTokens > bundle.totalTokens * 0.1
  ) {
    lines.push(formatTruncationWarning(bundle.omittedFiles, omittedTokens));
  }

  // Conversation context
  if (bundle.conversationContext) {
    lines.push(bundle.conversationContext);
    lines.push("---\n");
  }

  // PR context (metadata: title, body, comments, reviews)
  if (bundle.prContext) {
    lines.push(bundle.prContext);
    lines.push("---\n");
  }

  // Group files by category
  const categories: Record<FileEntry["category"], FileEntry[]> = {
    explicit: [],
    session: [],
    pr: [],
    git: [],
    dependency: [],
    dependent: [],
    test: [],
    type: [],
  };

  for (const file of bundle.files) {
    categories[file.category].push(file);
  }

  const categoryLabels: Record<FileEntry["category"], string> = {
    explicit: "Explicitly Included Files",
    session: "Modified Files (from Claude session)",
    pr: "Pull Request Changed Files",
    git: "Additional Git Changes",
    dependency: "Dependencies (files imported by modified code)",
    dependent: "Dependents (files that import modified code)",
    test: "Related Tests",
    type: "Type Definitions",
  };

  for (const [category, files] of Object.entries(categories)) {
    if (files.length === 0) continue;

    lines.push(`## ${categoryLabels[category as FileEntry["category"]]}\n`);

    for (const file of files) {
      const relativePath = path.relative(projectPath, file.path);
      const ext = path.extname(file.path).slice(1) || "txt";

      lines.push(`### ${relativePath}\n`);
      if (file.annotation) {
        lines.push(`*${file.annotation}*\n`);
      }
      lines.push("```" + ext);
      lines.push(file.content);
      lines.push("```\n");
    }
  }

  // Summary
  lines.push("---\n");
  lines.push("## Context Summary\n");
  lines.push(`- **Total files:** ${bundle.files.length}`);
  lines.push(`- **Estimated tokens:** ${bundle.totalTokens.toLocaleString()}`);
  lines.push(`- **Breakdown:**`);
  for (const [cat, tokens] of Object.entries(bundle.categories)) {
    if (tokens > 0) {
      lines.push(`  - ${cat}: ${tokens.toLocaleString()} tokens`);
    }
  }

  // Report omitted files
  if (bundle.omittedFiles.length > 0) {
    lines.push("");
    lines.push("### Omitted Files\n");
    lines.push(
      "The following files were not included due to token budget constraints or security restrictions:\n"
    );

    const byReason = {
      budget_exceeded: bundle.omittedFiles.filter(
        (f) => f.reason === "budget_exceeded"
      ),
      outside_project: bundle.omittedFiles.filter(
        (f) => f.reason === "outside_project"
      ),
      sensitive_path: bundle.omittedFiles.filter(
        (f) => f.reason === "sensitive_path"
      ),
      outside_project_requires_allowExternalFiles: bundle.omittedFiles.filter(
        (f) => f.reason === "outside_project_requires_allowExternalFiles"
      ),
    };

    if (byReason.sensitive_path.length > 0) {
      lines.push("**Blocked (sensitive path):**");
      for (const file of byReason.sensitive_path) {
        lines.push(`- ${file.path}`);
      }
      lines.push("");
    }

    if (byReason.outside_project_requires_allowExternalFiles.length > 0) {
      lines.push(
        "**Blocked (outside project - set allowExternalFiles: true to include):**"
      );
      for (const file of byReason.outside_project_requires_allowExternalFiles) {
        lines.push(`- ${file.path}`);
      }
      lines.push("");
    }

    if (byReason.budget_exceeded.length > 0) {
      lines.push("**Budget exceeded:**");
      for (const file of byReason.budget_exceeded) {
        const relativePath = path.relative(projectPath, file.path);
        lines.push(
          `- ${relativePath} (${file.category}, ~${file.tokenEstimate.toLocaleString()} tokens)`
        );
      }
      lines.push("");
    }

    if (byReason.outside_project.length > 0) {
      lines.push("**Outside project bounds:**");
      for (const file of byReason.outside_project) {
        lines.push(`- ${file.path} (${file.category})`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
