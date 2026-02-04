import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import {
  isGitRepo,
  getGitChanges,
  getFileDiff,
  getAllModifiedFiles,
} from "./git.js";
import {
  createTempDir,
  cleanupTempDir,
  createProjectStructure,
  initGitRepo,
  gitCommit,
} from "../test-utils.js";

describe("isGitRepo", () => {
  let tmpDir: string;
  let gitDir: string;
  let nonGitDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("git-repo");
    gitDir = path.join(tmpDir, "git-project");
    nonGitDir = path.join(tmpDir, "non-git-project");

    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(nonGitDir, { recursive: true });

    initGitRepo(gitDir);
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("returns true for git repositories", () => {
    expect(isGitRepo(gitDir)).toBe(true);
  });

  it("returns false for non-git directories", () => {
    expect(isGitRepo(nonGitDir)).toBe(false);
  });

  it("returns false for non-existent directories", () => {
    expect(isGitRepo("/non/existent/path")).toBe(false);
  });
});

describe("getGitChanges", () => {
  let tmpDir: string;
  let projectDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("git-changes");
    projectDir = path.join(tmpDir, "project");

    // Create project with initial files
    createProjectStructure(projectDir, {
      "src/index.ts": "export const main = 1;",
      "src/utils.ts": "export const util = 1;",
    });

    initGitRepo(projectDir);
    gitCommit(projectDir, "Initial commit");

    // Make some changes for testing
    // Modify a tracked file (unstaged)
    fs.writeFileSync(
      path.join(projectDir, "src/index.ts"),
      "export const main = 2;"
    );

    // Create a new untracked file
    fs.writeFileSync(
      path.join(projectDir, "src/new-file.ts"),
      "export const newFile = 1;"
    );
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("detects unstaged changes", () => {
    const changes = getGitChanges(projectDir);

    expect(changes.unstaged).toContainEqual(
      expect.stringContaining("index.ts")
    );
  });

  it("detects untracked files", () => {
    const changes = getGitChanges(projectDir);

    expect(changes.untracked).toContainEqual(
      expect.stringContaining("new-file.ts")
    );
  });

  it("returns empty for non-git directory", () => {
    const nonGitDir = path.join(tmpDir, "non-git");
    fs.mkdirSync(nonGitDir, { recursive: true });

    const changes = getGitChanges(nonGitDir);

    expect(changes.staged).toEqual([]);
    expect(changes.unstaged).toEqual([]);
    expect(changes.untracked).toEqual([]);
  });

  it("returns absolute paths for all changes", () => {
    const changes = getGitChanges(projectDir);

    for (const file of [...changes.staged, ...changes.unstaged, ...changes.untracked]) {
      expect(path.isAbsolute(file)).toBe(true);
    }
  });
});

describe("getGitChanges - staged changes", () => {
  let tmpDir: string;
  let projectDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("git-staged");
    projectDir = path.join(tmpDir, "project");

    createProjectStructure(projectDir, {
      "src/index.ts": "export const main = 1;",
    });

    initGitRepo(projectDir);
    gitCommit(projectDir, "Initial commit");

    // Modify and stage a file
    fs.writeFileSync(
      path.join(projectDir, "src/index.ts"),
      "export const main = 2;"
    );

    // Using execSync with static command - safe in test context
    execSync("git add src/index.ts", { cwd: projectDir, stdio: "pipe" });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("detects staged changes", () => {
    const changes = getGitChanges(projectDir);

    expect(changes.staged).toContainEqual(
      expect.stringContaining("index.ts")
    );
  });
});

describe("getFileDiff", () => {
  let tmpDir: string;
  let projectDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("git-diff");
    projectDir = path.join(tmpDir, "project");

    createProjectStructure(projectDir, {
      "src/index.ts": "export const main = 1;",
    });

    initGitRepo(projectDir);
    gitCommit(projectDir, "Initial commit");

    // Modify the file
    fs.writeFileSync(
      path.join(projectDir, "src/index.ts"),
      "export const main = 2;\nexport const extra = 3;"
    );
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("returns diff for modified file", () => {
    const diff = getFileDiff(
      projectDir,
      path.join(projectDir, "src/index.ts")
    );

    expect(diff).not.toBeNull();
    expect(diff).toContain("-export const main = 1;");
    expect(diff).toContain("+export const main = 2;");
  });

  it("returns null for non-existent file", () => {
    const diff = getFileDiff(
      projectDir,
      path.join(projectDir, "src/nonexistent.ts")
    );

    // File doesn't exist in working tree, so diff returns empty/null
    expect(diff === null || diff === "").toBe(true);
  });

  it("returns null for non-git directory", () => {
    const nonGitDir = path.join(tmpDir, "non-git");
    fs.mkdirSync(nonGitDir, { recursive: true });

    const diff = getFileDiff(nonGitDir, path.join(nonGitDir, "file.ts"));

    expect(diff).toBeNull();
  });
});

describe("getAllModifiedFiles", () => {
  let tmpDir: string;
  let projectDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("git-all-modified");
    projectDir = path.join(tmpDir, "project");

    createProjectStructure(projectDir, {
      "src/a.ts": "export const a = 1;",
      "src/b.ts": "export const b = 1;",
      "src/c.ts": "export const c = 1;",
    });

    initGitRepo(projectDir);
    gitCommit(projectDir, "Initial commit");

    // Create different types of changes
    // Modify and stage
    fs.writeFileSync(path.join(projectDir, "src/a.ts"), "export const a = 2;");
    // Using execSync with static command - safe in test context
    execSync("git add src/a.ts", { cwd: projectDir, stdio: "pipe" });

    // Modify without staging
    fs.writeFileSync(path.join(projectDir, "src/b.ts"), "export const b = 2;");

    // Add untracked
    fs.writeFileSync(path.join(projectDir, "src/d.ts"), "export const d = 1;");
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("combines and deduplicates all modified files", () => {
    const files = getAllModifiedFiles(projectDir);

    // Should include staged (a.ts), unstaged (b.ts), and untracked (d.ts)
    expect(files.some((f) => f.includes("a.ts"))).toBe(true);
    expect(files.some((f) => f.includes("b.ts"))).toBe(true);
    expect(files.some((f) => f.includes("d.ts"))).toBe(true);

    // Should NOT include unmodified (c.ts)
    expect(files.some((f) => f.includes("c.ts"))).toBe(false);
  });

  it("returns unique paths only", () => {
    const files = getAllModifiedFiles(projectDir);
    const uniqueFiles = new Set(files);

    expect(files.length).toBe(uniqueFiles.size);
  });

  it("returns empty array for non-git directory", () => {
    const nonGitDir = path.join(tmpDir, "non-git");
    fs.mkdirSync(nonGitDir, { recursive: true });

    const files = getAllModifiedFiles(nonGitDir);

    expect(files).toEqual([]);
  });
});
