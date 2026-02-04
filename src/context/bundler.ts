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
import { estimateTokens, BUDGET_ALLOCATION } from "../utils/tokens.js";

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
}


/**
 * Read a file and create a FileEntry
 */
function readFileEntry(
  filePath: string,
  category: FileEntry["category"],
  existingContent?: string
): FileEntry | null {
  try {
    const content = existingContent || fs.readFileSync(filePath, "utf-8");
    return {
      path: filePath,
      content,
      category,
      tokenEstimate: estimateTokens(content),
    };
  } catch {
    return null;
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
  };

  // Track files we've already added
  const addedFiles = new Set<string>();

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

  // Calculate budget for each category from remaining tokens
  const budgets = {
    explicit: Math.floor(remainingBudget * BUDGET_ALLOCATION.explicit),
    session: Math.floor(remainingBudget * BUDGET_ALLOCATION.session),
    git: Math.floor(remainingBudget * BUDGET_ALLOCATION.git),
    dependency: Math.floor(remainingBudget * BUDGET_ALLOCATION.dependency),
    dependent: Math.floor(remainingBudget * BUDGET_ALLOCATION.dependent),
    test: Math.floor(remainingBudget * BUDGET_ALLOCATION.test),
    type: Math.floor(remainingBudget * BUDGET_ALLOCATION.type),
  };

  // Helper to add files within a budget
  const addFilesWithBudget = (
    files: FileEntry[],
    category: FileEntry["category"],
    budget: number,
    options?: { skipBoundsCheck?: boolean }
  ): void => {
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
  };

  // 1a. Process explicitly included files first (highest priority)
  if (includeFiles.length > 0) {
    const explicitFiles: FileEntry[] = [];
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
        const entry = readFileEntry(filePath, "explicit");
        if (entry) {
          explicitFiles.push(entry);
        }
      }
    }
    // Explicit files skip bounds check since expandPath already checked
    addFilesWithBudget(explicitFiles, "explicit", budgets.explicit, { skipBoundsCheck: true });
  }

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
      const entry = readFileEntry(filePath, "session", cachedContent);
      if (entry) {
        sessionFiles.push(entry);
        if (
          sessionContext.filesWritten.includes(filePath) ||
          sessionContext.filesEdited.includes(filePath)
        ) {
          modifiedFiles.push(filePath);
        }
      }
    }
  }

  addFilesWithBudget(sessionFiles, "session", budgets.session);

  // 3. Git changes not in session
  const gitChangedFiles = getAllModifiedFiles(projectPath);
  const gitFiles: FileEntry[] = [];

  for (const filePath of gitChangedFiles) {
    if (!addedFiles.has(filePath)) {
      const entry = readFileEntry(filePath, "git");
      if (entry) {
        gitFiles.push(entry);
        modifiedFiles.push(filePath);
      }
    }
  }

  addFilesWithBudget(gitFiles, "git", budgets.git);

  // 4. Dependencies (files imported by modified files)
  if (includeDependencies && modifiedFiles.length > 0) {
    const deps = getDependenciesForFiles(modifiedFiles, projectPath);
    const depFiles: FileEntry[] = [];

    for (const dep of deps) {
      if (!addedFiles.has(dep)) {
        const entry = readFileEntry(dep, "dependency");
        if (entry) {
          depFiles.push(entry);
        }
      }
    }

    // Sort by token count (smaller files first to fit more)
    depFiles.sort((a, b) => a.tokenEstimate - b.tokenEstimate);
    addFilesWithBudget(depFiles, "dependency", budgets.dependency);
  }

  // 5. Dependents (files that import modified files)
  if (includeDependents && modifiedFiles.length > 0) {
    const dependents = await getDependentsForFiles(modifiedFiles, projectPath);
    const depFiles: FileEntry[] = [];

    for (const dep of dependents) {
      if (!addedFiles.has(dep)) {
        const entry = readFileEntry(dep, "dependent");
        if (entry) {
          depFiles.push(entry);
        }
      }
    }

    depFiles.sort((a, b) => a.tokenEstimate - b.tokenEstimate);
    addFilesWithBudget(depFiles, "dependent", budgets.dependent);
  }

  // 6. Test files
  if (includeTests && modifiedFiles.length > 0) {
    const tests = findTestFilesForFiles(modifiedFiles, projectPath);
    const testFiles: FileEntry[] = [];

    for (const test of tests) {
      if (!addedFiles.has(test)) {
        const entry = readFileEntry(test, "test");
        if (entry) {
          testFiles.push(entry);
        }
      }
    }

    addFilesWithBudget(testFiles, "test", budgets.test);
  }

  // 7. Type files
  if (includeTypes && modifiedFiles.length > 0) {
    const types = await findTypeFilesForFiles(modifiedFiles, projectPath);
    const typeFiles: FileEntry[] = [];

    for (const typeFile of types) {
      if (!addedFiles.has(typeFile)) {
        const entry = readFileEntry(typeFile, "type");
        if (entry) {
          typeFiles.push(entry);
        }
      }
    }

    addFilesWithBudget(typeFiles, "type", budgets.type);
  }

  return bundle;
}

/**
 * Format the bundle as markdown for the reviewer
 */
export function formatBundleAsMarkdown(
  bundle: ContextBundle,
  projectPath: string
): string {
  const lines: string[] = [];

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
