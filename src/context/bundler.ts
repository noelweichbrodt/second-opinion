import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  parseSession,
  findLatestSession,
  formatConversationContext,
  SessionContext,
} from "./session.js";
import { getAllModifiedFiles, getFileDiff } from "./git.js";
import {
  getDependenciesForFiles,
  getDependentsForFiles,
  isWithinProject,
} from "./imports.js";
import { findTestFilesForFiles } from "./tests.js";
import { findTypeFilesForFiles } from "./types.js";
import {
  estimateTokens,
  BUDGET_ALLOCATION,
  CATEGORY_PRIORITY_ORDER,
  BudgetCategory,
} from "../utils/tokens.js";
import { redactSecrets } from "../security/redactor.js";

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
}

export interface FileEntry {
  path: string;
  content: string;
  category:
    | "session"
    | "git"
    | "dependency"
    | "dependent"
    | "test"
    | "type"
    | "explicit";
  tokenEstimate: number;
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
  files: FileEntry[];
  omittedFiles: OmittedFile[];
  totalTokens: number;
  categories: {
    session: number;
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

/**
 * Collect and bundle all context for review
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
  } = options;

  const bundle: ContextBundle = {
    conversationContext: "",
    files: [],
    omittedFiles: [],
    totalTokens: 0,
    categories: {
      session: 0,
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

  // Track files we've already added
  const addedFiles = new Set<string>();

  // Track redaction types across all files
  const allRedactedTypes = new Set<string>();

  // Helper to accumulate redaction stats
  const accumulateRedactionStats = (result: ReadFileResult): void => {
    bundle.redactionStats.totalCount += result.redactionCount;
    for (const type of result.redactedTypes) {
      allRedactedTypes.add(type);
    }
  };

  // 1. Get session context first to know conversation size
  let sessionContext: SessionContext | null = null;
  const sid = sessionId || findLatestSession(projectPath);

  if (sid) {
    sessionContext = parseSession(projectPath, sid);
  }

  // Add conversation context and calculate remaining budget
  let remainingBudget = maxTokens;
  if (includeConversation && sessionContext) {
    bundle.conversationContext = formatConversationContext(sessionContext);
    const conversationTokens = estimateTokens(bundle.conversationContext);
    bundle.totalTokens += conversationTokens;
    remainingBudget -= conversationTokens;
  }

  // Calculate base budget for each category (used for spillover calculation)
  const baseBudgets: Record<BudgetCategory, number> = {
    explicit: Math.floor(remainingBudget * BUDGET_ALLOCATION.explicit),
    session: Math.floor(remainingBudget * BUDGET_ALLOCATION.session),
    git: Math.floor(remainingBudget * BUDGET_ALLOCATION.git),
    dependency: Math.floor(remainingBudget * BUDGET_ALLOCATION.dependency),
    dependent: Math.floor(remainingBudget * BUDGET_ALLOCATION.dependent),
    test: Math.floor(remainingBudget * BUDGET_ALLOCATION.test),
    type: Math.floor(remainingBudget * BUDGET_ALLOCATION.type),
  };

  // Track spillover budget from underutilized categories
  let spilloverBudget = 0;

  // Track omitted files per category for budget warnings
  const categoryOmissions: Partial<
    Record<BudgetCategory, { count: number; tokens: number; files: string[] }>
  > = {};

  // Helper to add files within a budget, returns tokens used
  const addFilesWithBudget = (
    files: FileEntry[],
    category: FileEntry["category"],
    budget: number,
    options?: { skipBoundsCheck?: boolean }
  ): number => {
    let used = 0;
    for (const file of files) {
      // Bounds check: skip files outside project (unless explicitly included)
      if (!options?.skipBoundsCheck && !isWithinProject(file.path, projectPath)) {
        bundle.omittedFiles.push({
          path: file.path,
          category,
          tokenEstimate: file.tokenEstimate,
          reason: "outside_project",
        });
        continue;
      }
      if (used + file.tokenEstimate > budget) {
        // Track omitted files that exceeded budget
        bundle.omittedFiles.push({
          path: file.path,
          category,
          tokenEstimate: file.tokenEstimate,
          reason: "budget_exceeded",
        });

        // Track omissions for high-priority categories (for budget warnings)
        if (category === "explicit" || category === "session") {
          if (!categoryOmissions[category]) {
            categoryOmissions[category] = { count: 0, tokens: 0, files: [] };
          }
          categoryOmissions[category]!.count++;
          categoryOmissions[category]!.tokens += file.tokenEstimate;
          categoryOmissions[category]!.files.push(file.path);
        }
        continue;
      }
      if (!addedFiles.has(file.path)) {
        bundle.files.push(file);
        addedFiles.add(file.path);
        used += file.tokenEstimate;
        bundle.categories[category] += file.tokenEstimate;
        bundle.totalTokens += file.tokenEstimate;
      }
    }
    return used;
  };

  /**
   * Get budget for a category including spillover from previous categories.
   * Updates spilloverBudget based on actual usage.
   */
  const getBudgetWithSpillover = (
    category: BudgetCategory,
    usedTokens: number
  ): void => {
    const baseBudget = baseBudgets[category];
    // Add half of the spillover to this category (save some for later categories)
    const bonusBudget = Math.floor(spilloverBudget * 0.5);
    const effectiveBudget = baseBudget + bonusBudget;

    // Calculate new spillover: unused from this category's base + remaining spillover
    const unusedFromBase = Math.max(0, baseBudget - usedTokens);
    spilloverBudget = unusedFromBase + (spilloverBudget - bonusBudget);
  };

  // 1a. Process explicitly included files first (highest priority)
  const explicitFiles: FileEntry[] = [];
  if (includeFiles.length > 0) {
    for (const inputPath of includeFiles) {
      const { files: expandedPaths, blocked } = expandPath(inputPath, projectPath, {
        allowExternalFiles,
      });

      // Track blocked paths (sensitive or outside project)
      for (const blockedFile of blocked) {
        bundle.omittedFiles.push({
          path: blockedFile.path,
          category: "explicit",
          tokenEstimate: 0,
          reason: blockedFile.reason,
        });
      }

      for (const filePath of expandedPaths) {
        const result = readFileEntry(filePath, "explicit");
        if (result.entry) {
          explicitFiles.push(result.entry);
          accumulateRedactionStats(result);
        }
      }
    }
  }
  // Process explicit files with spillover tracking
  const explicitBudget = baseBudgets.explicit + spilloverBudget;
  const explicitUsed = addFilesWithBudget(explicitFiles, "explicit", explicitBudget, {
    skipBoundsCheck: true,
  });
  getBudgetWithSpillover("explicit", explicitUsed);

  // 2. Collect session files (files Claude read/edited/wrote)
  const sessionFiles: FileEntry[] = [];
  const modifiedFiles: string[] = [];

  if (sessionContext) {
    // Files from session - use content Claude saw if available
    const allSessionFiles = [
      ...sessionContext.filesWritten,
      ...sessionContext.filesEdited,
      ...sessionContext.filesRead,
    ];

    for (const filePath of allSessionFiles) {
      const cachedContent = sessionContext.fileContents.get(filePath);
      const result = readFileEntry(filePath, "session", cachedContent);
      if (result.entry) {
        sessionFiles.push(result.entry);
        accumulateRedactionStats(result);
        if (
          sessionContext.filesWritten.includes(filePath) ||
          sessionContext.filesEdited.includes(filePath)
        ) {
          modifiedFiles.push(filePath);
        }
      }
    }
  }

  // Process session files with spillover
  const sessionBudget = baseBudgets.session + Math.floor(spilloverBudget * 0.5);
  const sessionUsed = addFilesWithBudget(sessionFiles, "session", sessionBudget);
  getBudgetWithSpillover("session", sessionUsed);

  // 3. Git changes not in session
  const gitChangedFiles = getAllModifiedFiles(projectPath);
  const gitFiles: FileEntry[] = [];

  for (const filePath of gitChangedFiles) {
    if (!addedFiles.has(filePath)) {
      const result = readFileEntry(filePath, "git");
      if (result.entry) {
        gitFiles.push(result.entry);
        accumulateRedactionStats(result);
        modifiedFiles.push(filePath);
      }
    }
  }

  // Process git files with spillover
  const gitBudget = baseBudgets.git + Math.floor(spilloverBudget * 0.5);
  const gitUsed = addFilesWithBudget(gitFiles, "git", gitBudget);
  getBudgetWithSpillover("git", gitUsed);

  // 4. Dependencies (files imported by modified files)
  const depFiles: FileEntry[] = [];
  if (includeDependencies && modifiedFiles.length > 0) {
    const deps = getDependenciesForFiles(modifiedFiles, projectPath);

    for (const dep of deps) {
      if (!addedFiles.has(dep)) {
        const result = readFileEntry(dep, "dependency");
        if (result.entry) {
          depFiles.push(result.entry);
          accumulateRedactionStats(result);
        }
      }
    }

    // Sort by token count (smaller files first to fit more)
    depFiles.sort((a, b) => a.tokenEstimate - b.tokenEstimate);
  }
  // Process dependency files with spillover
  const depBudget = baseBudgets.dependency + Math.floor(spilloverBudget * 0.5);
  const depUsed = addFilesWithBudget(depFiles, "dependency", depBudget);
  getBudgetWithSpillover("dependency", depUsed);

  // 5. Dependents (files that import modified files)
  const dependentFiles: FileEntry[] = [];
  if (includeDependents && modifiedFiles.length > 0) {
    const dependents = await getDependentsForFiles(modifiedFiles, projectPath);

    for (const dep of dependents) {
      if (!addedFiles.has(dep)) {
        const result = readFileEntry(dep, "dependent");
        if (result.entry) {
          dependentFiles.push(result.entry);
          accumulateRedactionStats(result);
        }
      }
    }

    dependentFiles.sort((a, b) => a.tokenEstimate - b.tokenEstimate);
  }
  // Process dependent files with spillover
  const dependentBudget = baseBudgets.dependent + Math.floor(spilloverBudget * 0.5);
  const dependentUsed = addFilesWithBudget(dependentFiles, "dependent", dependentBudget);
  getBudgetWithSpillover("dependent", dependentUsed);

  // 6. Test files
  const testFiles: FileEntry[] = [];
  if (includeTests && modifiedFiles.length > 0) {
    const tests = findTestFilesForFiles(modifiedFiles, projectPath);

    for (const test of tests) {
      if (!addedFiles.has(test)) {
        const result = readFileEntry(test, "test");
        if (result.entry) {
          testFiles.push(result.entry);
          accumulateRedactionStats(result);
        }
      }
    }
  }
  // Process test files with spillover
  const testBudget = baseBudgets.test + Math.floor(spilloverBudget * 0.5);
  const testUsed = addFilesWithBudget(testFiles, "test", testBudget);
  getBudgetWithSpillover("test", testUsed);

  // 7. Type files
  const typeFiles: FileEntry[] = [];
  if (includeTypes && modifiedFiles.length > 0) {
    const types = await findTypeFilesForFiles(modifiedFiles, projectPath);

    for (const typeFile of types) {
      if (!addedFiles.has(typeFile)) {
        const result = readFileEntry(typeFile, "type");
        if (result.entry) {
          typeFiles.push(result.entry);
          accumulateRedactionStats(result);
        }
      }
    }
  }
  // Process type files with spillover (gets all remaining spillover)
  const typeBudget = baseBudgets.type + spilloverBudget;
  addFilesWithBudget(typeFiles, "type", typeBudget);

  // Finalize redaction stats
  bundle.redactionStats.types = Array.from(allRedactedTypes);

  // Generate budget warnings for high-priority file omissions
  for (const [category, info] of Object.entries(categoryOmissions)) {
    if (info && info.count > 0) {
      const suggestedBudget =
        Math.ceil((maxTokens + info.tokens + 5000) / 10000) * 10000; // Round up to nearest 10k
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

  // Group files by category
  const categories: Record<FileEntry["category"], FileEntry[]> = {
    explicit: [],
    session: [],
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
