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
 * Get all modified files (staged + unstaged + untracked) as a single list
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
