import { spawnSync } from "child_process";
import * as path from "path";
import { redactSecrets } from "../security/redactor.js";

export interface PRComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface PRReview {
  author: string;
  body: string;
  state: string; // APPROVED, CHANGES_REQUESTED, COMMENTED
  createdAt: string;
}

export interface PRContext {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  baseBranch: string;
  headBranch: string;
  labels: string[];
  comments: PRComment[];
  reviews: PRReview[];
  changedFiles: string[];
}

export type PRDetectionResult =
  | { ok: true; pr: PRContext }
  | { ok: false; reason: "gh_not_installed" | "gh_command_failed" | "no_pr_found" | "parse_error"; message: string };

/** Raw shapes from `gh pr view --json` output */
interface GhComment {
  author?: { login?: string };
  body?: string;
  createdAt?: string;
}

interface GhReview extends GhComment {
  state?: string;
}

interface GhLabel {
  name?: string;
}

interface GhFile {
  path?: string;
}

const SPAWN_OPTS = {
  encoding: "utf-8" as const,
  stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
};

/**
 * Check if the GitHub CLI (gh) is installed and accessible
 */
export function isGhAvailable(): boolean {
  return spawnSync("gh", ["--version"], SPAWN_OPTS).status === 0;
}

/**
 * Detect a PR associated with the current branch or a specific PR number.
 * Returns a discriminated union with failure reason on error.
 */
export function detectPR(
  projectPath: string,
  prNumber?: number
): PRDetectionResult {
  if (!isGhAvailable()) {
    return {
      ok: false,
      reason: "gh_not_installed",
      message: "GitHub CLI (gh) is not installed. Install from https://cli.github.com/ for PR context detection.",
    };
  }

  try {
    const fields =
      "number,title,body,url,state,baseRefName,headRefName,labels,comments,reviews,files";

    const args = prNumber
      ? ["pr", "view", String(prNumber), "--json", fields]
      : ["pr", "view", "--json", fields];

    const result = spawnSync("gh", args, { cwd: projectPath, ...SPAWN_OPTS });

    if (result.error || result.status !== 0) {
      const stderr = (result.stderr || "").trim();
      // "no pull requests found" is a normal condition, not an error
      if (stderr.includes("no pull requests found") || stderr.includes("Could not resolve")) {
        return { ok: false, reason: "no_pr_found", message: "No pull request found for the current branch." };
      }
      return {
        ok: false,
        reason: "gh_command_failed",
        message: `gh pr view failed: ${stderr.slice(0, 200)}`,
      };
    }

    const data = JSON.parse(result.stdout);

    const pr: PRContext = {
      number: data.number,
      title: data.title || "",
      body: data.body || "",
      url: data.url || "",
      state: data.state || "",
      baseBranch: data.baseRefName || "",
      headBranch: data.headRefName || "",
      labels: (data.labels || []).map((l: GhLabel) => l.name || ""),
      comments: (data.comments || []).map((c: GhComment) => ({
        author: c.author?.login || "unknown",
        body: c.body || "",
        createdAt: c.createdAt || "",
      })),
      reviews: (data.reviews || []).map((r: GhReview) => ({
        author: r.author?.login || "unknown",
        body: r.body || "",
        state: r.state || "COMMENTED",
        createdAt: r.createdAt || "",
      })),
      changedFiles: (data.files || [])
        .map((f: GhFile) => f.path)
        .filter(Boolean)
        .map((p: string) => path.join(projectPath, p)),
    };

    // Fallback: if gh returned no files but we have a base branch, use git diff
    if (pr.changedFiles.length === 0 && pr.baseBranch) {
      pr.changedFiles = getPRChangedFiles(projectPath, pr.baseBranch);
    }

    return { ok: true, pr };
  } catch {
    return { ok: false, reason: "parse_error", message: "Failed to parse gh pr view output." };
  }
}

/**
 * Get changed files between the PR base branch and HEAD via git diff.
 * Fallback/complement to the files field from gh pr view.
 */
export function getPRChangedFiles(
  projectPath: string,
  baseBranch: string
): string[] {
  try {
    const result = spawnSync(
      "git",
      ["diff", `${baseBranch}...HEAD`, "--name-only"],
      { cwd: projectPath, ...SPAWN_OPTS }
    );

    if (result.error || result.status !== 0) {
      return [];
    }

    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((f) => path.join(projectPath, f));
  } catch {
    return [];
  }
}

/**
 * Format PR metadata (title, body, comments, reviews) as markdown.
 * All text content is run through redactSecrets before inclusion.
 */
export function formatPRMetadata(pr: PRContext): string {
  const lines: string[] = [];

  lines.push(`## Pull Request #${pr.number}\n`);
  lines.push(`**${redactSecrets(pr.title).content}**\n`);
  lines.push(`- **URL:** ${pr.url}`);
  lines.push(`- **State:** ${pr.state}`);
  lines.push(`- **Base:** ${pr.baseBranch} ← **Head:** ${pr.headBranch}`);

  if (pr.labels.length > 0) {
    lines.push(`- **Labels:** ${pr.labels.join(", ")}`);
  }

  lines.push("");

  // PR body
  if (pr.body) {
    lines.push("### Description\n");
    lines.push(redactSecrets(pr.body).content);
    lines.push("");
  }

  // Discussion comments
  if (pr.comments.length > 0) {
    lines.push("### Discussion Comments\n");
    for (const comment of pr.comments) {
      lines.push(`**${comment.author}** (${comment.createdAt}):`);
      lines.push(redactSecrets(comment.body).content);
      lines.push("");
    }
  }

  // Reviews
  if (pr.reviews.length > 0) {
    lines.push("### Reviews\n");
    for (const review of pr.reviews) {
      lines.push(
        `**${review.author}** — ${review.state} (${review.createdAt}):`
      );
      if (review.body) {
        lines.push(redactSecrets(review.body).content);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
