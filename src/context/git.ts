import { execSync, spawnSync } from "child_process";
import * as path from "path";

export interface GitChanges {
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

/**
 * Check if a directory is a git repository
 */
export function isGitRepo(projectPath: string): boolean {
  try {
    execSync("git rev-parse --git-dir", {
      cwd: projectPath,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all modified files from git
 */
export function getGitChanges(projectPath: string): GitChanges {
  const changes: GitChanges = {
    staged: [],
    unstaged: [],
    untracked: [],
  };

  if (!isGitRepo(projectPath)) {
    return changes;
  }

  try {
    // Staged changes
    const staged = execSync("git diff --cached --name-only", {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    changes.staged = staged
      .split("\n")
      .filter(Boolean)
      .map((f) => path.join(projectPath, f));

    // Unstaged changes
    const unstaged = execSync("git diff --name-only", {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    changes.unstaged = unstaged
      .split("\n")
      .filter(Boolean)
      .map((f) => path.join(projectPath, f));

    // Untracked files
    const untracked = execSync("git ls-files --others --exclude-standard", {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    changes.untracked = untracked
      .split("\n")
      .filter(Boolean)
      .map((f) => path.join(projectPath, f));
  } catch {
    // Git commands failed, return empty
  }

  return changes;
}

/**
 * Get the diff content for a file
 */
export function getFileDiff(
  projectPath: string,
  filePath: string
): string | null {
  if (!isGitRepo(projectPath)) {
    return null;
  }

  try {
    const relativePath = path.relative(projectPath, filePath);
    // Use spawnSync with argument array to prevent command injection
    const result = spawnSync("git", ["diff", "HEAD", "--", relativePath], {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    return result.stdout || null;
  } catch {
    return null;
  }
}

/**
 * Get all modified files (staged + unstaged + untracked) as a single list.
 */
export function getAllModifiedFiles(projectPath: string): string[] {
  const changes = getGitChanges(projectPath);
  const allFiles = new Set<string>([
    ...changes.staged,
    ...changes.unstaged,
    ...changes.untracked,
  ]);
  return Array.from(allFiles);
}

/**
 * Get the current git branch name.
 * Returns null if not in a git repo or in detached HEAD state.
 */
export function getCurrentBranch(projectPath: string): string | null {
  if (!isGitRepo(projectPath)) {
    return null;
  }
  try {
    const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    const branch = result.stdout.trim();
    // Detached HEAD returns "HEAD"
    return branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}

/**
 * Get the default branch (main or master) for the repo.
 * Returns null if neither exists.
 */
export function getDefaultBranch(projectPath: string): string | null {
  if (!isGitRepo(projectPath)) {
    return null;
  }
  for (const branch of ["main", "master"]) {
    const result = spawnSync(
      "git",
      ["rev-parse", "--verify", `refs/heads/${branch}`],
      {
        cwd: projectPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    if (!result.error && result.status === 0) {
      return branch;
    }
  }
  return null;
}

/**
 * Get the unified diff between the current branch and a base branch.
 * If baseBranch is not provided, auto-detects via getDefaultBranch().
 * Returns null if on the default branch, not in a git repo, or no diff available.
 */
export function getBranchDiff(
  projectPath: string,
  baseBranch?: string
): string | null {
  if (!isGitRepo(projectPath)) {
    return null;
  }

  const currentBranch = getCurrentBranch(projectPath);
  if (!currentBranch) {
    return null;
  }

  const base = baseBranch || getDefaultBranch(projectPath);
  if (!base) {
    return null;
  }

  // Don't diff against self
  if (currentBranch === base) {
    return null;
  }

  try {
    // Three-dot diff: changes since branching from base
    const result = spawnSync("git", ["diff", `${base}...HEAD`], {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    return result.stdout || null;
  } catch {
    return null;
  }
}
