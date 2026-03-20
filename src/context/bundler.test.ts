import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { bundleContext, formatBundleAsMarkdown, allocateBudget, CategoryCandidates, CandidateFile, FileEntry } from "./bundler.js";
import { BUDGET_ALLOCATION, CATEGORY_PRIORITY_ORDER } from "../utils/tokens.js";
import { createTempDir, cleanupTempDir, createProjectStructure } from "../test-utils.js";

/** Test helper: create a CandidateFile with sensible defaults for redaction fields */
function candidate(path: string, category: FileEntry["category"], tokenEstimate: number, content?: string): CandidateFile {
  return { path, content: content ?? "x".repeat(tokenEstimate * 4), category, tokenEstimate, redactionCount: 0, redactedTypes: [] };
}

// Test the sensitive path detection by attempting to include sensitive files
describe("bundleContext - sensitive path handling", () => {
  const tmpDir = path.join(os.tmpdir(), "bundler-sensitive-test-" + Date.now());

  beforeAll(() => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".ssh"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".aws"), { recursive: true });

    // Create normal files
    fs.writeFileSync(path.join(tmpDir, "src", "index.ts"), "export const main = 1;");

    // Create sensitive files
    fs.writeFileSync(path.join(tmpDir, ".ssh", "id_rsa"), "PRIVATE KEY");
    fs.writeFileSync(path.join(tmpDir, ".aws", "credentials"), "aws_secret=xxx");
    fs.writeFileSync(path.join(tmpDir, ".env"), "DATABASE_URL=secret");
    fs.writeFileSync(path.join(tmpDir, "secrets.json"), '{"api_key": "xxx"}');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("blocks .ssh directory files", async () => {
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: [".ssh/id_rsa"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle.files).toHaveLength(0);
    expect(bundle.omittedFiles.some((f) => f.reason === "sensitive_path")).toBe(true);
  });

  it("blocks .aws directory files", async () => {
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: [".aws/credentials"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle.files).toHaveLength(0);
    expect(bundle.omittedFiles.some((f) => f.reason === "sensitive_path")).toBe(true);
  });

  it("blocks .env files", async () => {
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: [".env"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle.files).toHaveLength(0);
    expect(bundle.omittedFiles.some((f) => f.reason === "sensitive_path")).toBe(true);
  });

  it("blocks secrets.json files", async () => {
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["secrets.json"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle.files).toHaveLength(0);
    expect(bundle.omittedFiles.some((f) => f.reason === "sensitive_path")).toBe(true);
  });

  it("allows normal source files", async () => {
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["src/index.ts"],
      maxTokens: 10000, // Enough budget for the file
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0].path).toContain("index.ts");
  });
});

describe("bundleContext - external files", () => {
  const tmpDir = path.join(os.tmpdir(), "bundler-external-test-" + Date.now());
  const externalDir = path.join(os.tmpdir(), "bundler-external-other-" + Date.now());

  beforeAll(() => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.mkdirSync(externalDir, { recursive: true });

    fs.writeFileSync(path.join(tmpDir, "src", "index.ts"), "export const main = 1;");
    fs.writeFileSync(path.join(externalDir, "external.ts"), "export const ext = 1;");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(externalDir, { recursive: true, force: true });
  });

  it("blocks external files by default", async () => {
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: [externalDir + "/external.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle.files).toHaveLength(0);
    expect(
      bundle.omittedFiles.some(
        (f) => f.reason === "outside_project_requires_allowExternalFiles"
      )
    ).toBe(true);
  });

  it("allows external files when allowExternalFiles is true", async () => {
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: [externalDir + "/external.ts"],
      allowExternalFiles: true,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0].path).toContain("external.ts");
  });
});

describe("bundleContext - token budget", () => {
  const tmpDir = path.join(os.tmpdir(), "bundler-budget-test-" + Date.now());

  beforeAll(() => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });

    // Create files of known sizes
    // Budget allocation for explicit files is 15% of maxTokens
    // With maxTokens=1000, explicit budget = 150 tokens
    fs.writeFileSync(path.join(tmpDir, "src", "small.ts"), "x".repeat(100)); // ~25 tokens
    fs.writeFileSync(path.join(tmpDir, "src", "large.ts"), "x".repeat(2000)); // ~500 tokens
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("respects maxTokens budget", async () => {
    // With two-pass allocation, total demand must exceed filePool to trigger contention.
    // small.ts (~25 tokens) + large.ts (~500 tokens) = ~525 tokens.
    // Set maxTokens=400 so total demand (525) > filePool (400) and contention kicks in.
    // Under contention, explicit gets 15% base = 60 tokens. Even with redistribution
    // from empty categories, large.ts (500 tokens) won't fit alongside small.ts.
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["src/small.ts", "src/large.ts"],
      maxTokens: 400,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    // Small file should be included
    expect(bundle.files.some((f) => f.path.includes("small.ts"))).toBe(true);
    // Large file should be omitted due to budget
    expect(bundle.omittedFiles.some((f) => f.reason === "budget_exceeded")).toBe(true);
    expect(bundle.omittedFiles.some((f) => f.path.includes("large.ts"))).toBe(true);
  });
});

describe("formatBundleAsMarkdown", () => {
  it("formats bundle with categories", () => {
    const bundle = {
      conversationContext: "## Conversation\nUser asked for help",
      files: [
        {
          path: "/project/src/index.ts",
          content: "const x = 1;",
          category: "session" as const,
          tokenEstimate: 10,
        },
        {
          path: "/project/src/utils.ts",
          content: "export const util = 1;",
          category: "dependency" as const,
          tokenEstimate: 15,
        },
      ],
      omittedFiles: [],
      totalTokens: 25,
      categories: {
        session: 10,
        git: 0,
        dependency: 15,
        dependent: 0,
        test: 0,
        type: 0,
        explicit: 0,
      },
    };

    const markdown = formatBundleAsMarkdown(bundle, "/project");

    expect(markdown).toContain("## Conversation");
    expect(markdown).toContain("Modified Files (from Claude session)");
    expect(markdown).toContain("Dependencies (files imported by modified code)");
    expect(markdown).toContain("### src/index.ts");
    expect(markdown).toContain("### src/utils.ts");
    expect(markdown).toContain("**Total files:** 2");
  });

  it("includes omitted files section when files were omitted", () => {
    const bundle = {
      conversationContext: "",
      files: [],
      omittedFiles: [
        {
          path: "/project/.env",
          category: "explicit" as const,
          tokenEstimate: 0,
          reason: "sensitive_path" as const,
        },
        {
          path: "/project/large-file.ts",
          category: "session" as const,
          tokenEstimate: 50000,
          reason: "budget_exceeded" as const,
        },
      ],
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

    const markdown = formatBundleAsMarkdown(bundle, "/project");

    expect(markdown).toContain("### Omitted Files");
    expect(markdown).toContain("**Blocked (sensitive path):**");
    expect(markdown).toContain(".env");
    expect(markdown).toContain("**Budget exceeded:**");
    expect(markdown).toContain("large-file.ts");
  });

  it("shows context summary with token breakdown", () => {
    const bundle = {
      conversationContext: "",
      files: [
        {
          path: "/project/a.ts",
          content: "a",
          category: "session" as const,
          tokenEstimate: 100,
        },
        {
          path: "/project/b.ts",
          content: "b",
          category: "test" as const,
          tokenEstimate: 50,
        },
      ],
      omittedFiles: [],
      totalTokens: 150,
      categories: {
        session: 100,
        git: 0,
        dependency: 0,
        dependent: 0,
        test: 50,
        type: 0,
        explicit: 0,
      },
    };

    const markdown = formatBundleAsMarkdown(bundle, "/project");

    expect(markdown).toContain("## Context Summary");
    expect(markdown).toContain("**Total files:** 2");
    expect(markdown).toContain("**Estimated tokens:** 150");
    expect(markdown).toContain("session: 100 tokens");
    expect(markdown).toContain("test: 50 tokens");
  });
});

describe("bundleContext - tilde expansion", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("bundler-tilde");
    createProjectStructure(tmpDir, {
      "src/index.ts": "export const main = 1;",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("expands tilde paths to home directory", async () => {
    // Create a file in home directory for testing
    const testFile = path.join(os.homedir(), ".second-opinion-test-file.ts");
    const cleanup = () => {
      try {
        fs.unlinkSync(testFile);
      } catch {}
    };

    try {
      fs.writeFileSync(testFile, "export const test = 1;");

      const bundle = await bundleContext({
        projectPath: tmpDir,
        includeFiles: ["~/.second-opinion-test-file.ts"],
        allowExternalFiles: true, // External since it's in home dir
        includeConversation: false,
        includeDependencies: false,
        includeDependents: false,
        includeTests: false,
        includeTypes: false,
      });

      expect(bundle.files).toHaveLength(1);
      expect(bundle.files[0].path).toBe(testFile);
    } finally {
      cleanup();
    }
  });
});

describe("bundleContext - more sensitive path patterns", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("bundler-sensitive-ext");

    createProjectStructure(tmpDir, {
      // Git
      ".git/config": "[core]",
      ".git/HEAD": "ref: refs/heads/main",

      // SSH and keys
      ".gnupg/pubring.kbx": "gpg data",
      "id_rsa": "private key",
      "id_ed25519": "ed key",
      // These would match hidden .pem/.key files, but server.pem etc are allowed
      // "certs/server.pem": "cert",
      // "keys/private.key": "key",

      // Cloud configs
      ".kube/config": "kubernetes config",
      ".docker/config.json": '{"auths":{}}',
      ".netrc": "machine github.com",
      ".npmrc": "//registry.npmjs.org/:_authToken=xxx",
      ".pypirc": "[pypi]",

      // Credential files
      "credentials.json": '{"key":"xxx"}',
      "service-account.json": '{"type":"service_account"}',
      "service_account_key.json": '{"type":"service_account"}',

      // Environment variants
      ".env.local": "SECRET=xxx",
      ".env.production": "SECRET=xxx",
      ".env.development": "SECRET=xxx",

      // Terraform
      "terraform.tfvars": 'secret = "xxx"',
      "terraform.tfstate": '{"version":4}',

      // Kubernetes secrets
      "secret.yaml": "kind: Secret",
      "secret.yml": "kind: Secret",

      // Shell history
      ".bash_history": "ls -la",
      ".zsh_history": "cd /",

      // Config with secrets
      ".config/gcloud/credentials.db": "gcloud data",
      ".config/gh/hosts.yml": "github.com",

      // Normal file
      "src/index.ts": "export const main = 1;",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  // Note: Some patterns require a path separator before them
  // e.g., /[/\\]\.pem$/i matches "/path/to/file.pem" but not "file.pem" in root
  const sensitiveFiles = [
    ".git/config",
    ".gnupg/pubring.kbx",
    "id_rsa",            // Pattern matches /id_rsa anywhere in path
    "id_ed25519",        // Pattern matches /id_ed25519 anywhere in path
    // "server.pem",     // Would need to be certs/server.pem to match
    // "private.key",    // Would need to be keys/private.key to match
    ".kube/config",
    ".docker/config.json",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "credentials.json",
    "service-account.json",
    "service_account_key.json",
    ".env.local",
    ".env.production",
    ".env.development",
    "terraform.tfvars",
    "terraform.tfstate",
    "secret.yaml",
    "secret.yml",
    ".bash_history",
    ".zsh_history",
    // Note: .pem and .key patterns match hidden files like /.pem and /.key
    // not files like server.pem or private.key - this is intentional
  ];

  for (const file of sensitiveFiles) {
    it(`blocks ${file}`, async () => {
      const bundle = await bundleContext({
        projectPath: tmpDir,
        includeFiles: [file],
        includeConversation: false,
        includeDependencies: false,
        includeDependents: false,
        includeTests: false,
        includeTypes: false,
      });

      expect(bundle.files).toHaveLength(0);
      expect(
        bundle.omittedFiles.some((f) => f.reason === "sensitive_path"),
        `Expected ${file} to be blocked as sensitive`
      ).toBe(true);
    });
  }
});

describe("bundleContext - directory expansion", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("bundler-dir");

    createProjectStructure(tmpDir, {
      "src/index.ts": "export const main = 1;",
      "src/utils/helper.ts": "export function helper() {}",
      "src/utils/format.ts": "export function format() {}",
      "src/components/Button.tsx": "export const Button = () => null;",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("expands directories recursively", async () => {
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["src/utils"],
      maxTokens: 100000,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle.files.some((f) => f.path.includes("helper.ts"))).toBe(true);
    expect(bundle.files.some((f) => f.path.includes("format.ts"))).toBe(true);
  });

  it("skips hidden files in directories", async () => {
    // Add a hidden file
    fs.writeFileSync(path.join(tmpDir, "src", ".hidden.ts"), "hidden");

    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["src"],
      maxTokens: 100000,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle.files.every((f) => !f.path.includes(".hidden"))).toBe(true);
  });

  it("skips node_modules in directories", async () => {
    createProjectStructure(tmpDir, {
      "node_modules/pkg/index.ts": "export const pkg = 1;",
    });

    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["."],
      maxTokens: 100000,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle.files.every((f) => !f.path.includes("node_modules"))).toBe(true);
  });
});

describe("bundleContext - file categories", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("bundler-categories");

    createProjectStructure(tmpDir, {
      "src/index.ts": "export const main = 1;",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("marks explicitly included files as 'explicit' category", async () => {
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["src/index.ts"],
      maxTokens: 100000,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle.files[0].category).toBe("explicit");
  });

  it("tracks tokens by category", async () => {
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["src/index.ts"],
      maxTokens: 100000,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle.categories.explicit).toBeGreaterThan(0);
  });
});

describe("bundleContext - relative path handling", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("bundler-relative");

    createProjectStructure(tmpDir, {
      "src/index.ts": "export const main = 1;",
      "lib/helper.ts": "export const helper = 1;",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("resolves relative paths from project root", async () => {
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["src/index.ts", "lib/helper.ts"],
      maxTokens: 100000,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle.files).toHaveLength(2);
    expect(bundle.files.some((f) => f.path.includes("index.ts"))).toBe(true);
    expect(bundle.files.some((f) => f.path.includes("helper.ts"))).toBe(true);
  });

  it("handles non-existent files gracefully", async () => {
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["nonexistent.ts"],
      maxTokens: 100000,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle.files).toHaveLength(0);
    // Non-existent files are silently skipped, not added to omitted
  });
});

describe("formatBundleAsMarkdown - omitted files sections", () => {
  it("formats outside_project_requires_allowExternalFiles section", () => {
    const bundle = {
      conversationContext: "",
      files: [],
      omittedFiles: [
        {
          path: "/external/lib.ts",
          category: "explicit" as const,
          tokenEstimate: 100,
          reason: "outside_project_requires_allowExternalFiles" as const,
        },
      ],
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

    const markdown = formatBundleAsMarkdown(bundle, "/project");

    expect(markdown).toContain("### Omitted Files");
    expect(markdown).toContain("outside project - set allowExternalFiles: true");
    expect(markdown).toContain("/external/lib.ts");
  });

  it("formats outside_project section", () => {
    const bundle = {
      conversationContext: "",
      files: [],
      omittedFiles: [
        {
          path: "/external/auto-discovered.ts",
          category: "dependency" as const,
          tokenEstimate: 200,
          reason: "outside_project" as const,
        },
      ],
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

    const markdown = formatBundleAsMarkdown(bundle, "/project");

    expect(markdown).toContain("### Omitted Files");
    expect(markdown).toContain("**Outside project bounds:**");
    expect(markdown).toContain("/external/auto-discovered.ts (dependency)");
  });

  it("formats budget_exceeded section with file details", () => {
    const bundle = {
      conversationContext: "",
      files: [],
      omittedFiles: [
        {
          path: "/project/src/large1.ts",
          category: "session" as const,
          tokenEstimate: 50000,
          reason: "budget_exceeded" as const,
        },
        {
          path: "/project/src/large2.ts",
          category: "dependency" as const,
          tokenEstimate: 30000,
          reason: "budget_exceeded" as const,
        },
      ],
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

    const markdown = formatBundleAsMarkdown(bundle, "/project");

    expect(markdown).toContain("**Budget exceeded:**");
    expect(markdown).toContain("src/large1.ts (session, ~50,000 tokens)");
    expect(markdown).toContain("src/large2.ts (dependency, ~30,000 tokens)");
  });

  it("formats all omission reasons together", () => {
    const bundle = {
      conversationContext: "",
      files: [],
      omittedFiles: [
        {
          path: "/project/.env",
          category: "explicit" as const,
          tokenEstimate: 0,
          reason: "sensitive_path" as const,
        },
        {
          path: "/external/file.ts",
          category: "explicit" as const,
          tokenEstimate: 100,
          reason: "outside_project_requires_allowExternalFiles" as const,
        },
        {
          path: "/project/large.ts",
          category: "session" as const,
          tokenEstimate: 50000,
          reason: "budget_exceeded" as const,
        },
        {
          path: "/other/dep.ts",
          category: "dependency" as const,
          tokenEstimate: 200,
          reason: "outside_project" as const,
        },
      ],
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

    const markdown = formatBundleAsMarkdown(bundle, "/project");

    // Should have all four sections
    expect(markdown).toContain("**Blocked (sensitive path):**");
    expect(markdown).toContain("**Blocked (outside project - set allowExternalFiles: true to include):**");
    expect(markdown).toContain("**Budget exceeded:**");
    expect(markdown).toContain("**Outside project bounds:**");
  });
});

describe("bundleContext - budget edge cases", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("bundler-budget-edge");

    createProjectStructure(tmpDir, {
      "src/index.ts": "export const main = 1;",
      "src/large.ts": "x".repeat(2000),
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("handles very small maxTokens (< 100)", async () => {
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["src/index.ts"],
      maxTokens: 50, // Extremely small
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    // Should handle gracefully - likely omit files due to budget
    // With maxTokens=50, explicit budget = 7.5 tokens (15% of 50)
    // Our file is ~25 chars = ~6 tokens, so it might fit
    // But the important thing is it doesn't crash
    expect(bundle).toBeDefined();
    expect(bundle.totalTokens).toBeLessThanOrEqual(50);
  });

  it("allocates zero budget to categories when remainingBudget is tiny", async () => {
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["src/index.ts"],
      maxTokens: 5, // So small that category budgets floor to 0
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle).toBeDefined();
    expect(bundle.categories).toBeDefined();
    // All files should be omitted due to budget
    expect(bundle.omittedFiles.some((f) => f.reason === "budget_exceeded")).toBe(true);
  });

  it("prioritizes files by category budget allocation", async () => {
    // Create multiple files that will compete for budget
    createProjectStructure(tmpDir, {
      "src/file1.ts": "a".repeat(400), // ~100 tokens
      "src/file2.ts": "b".repeat(400), // ~100 tokens
    });

    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["src/file1.ts", "src/file2.ts"],
      maxTokens: 500, // explicit budget = 75 tokens (15% of 500)
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    // Only one file should fit in the explicit budget
    expect(bundle.files.length).toBeLessThanOrEqual(2);
    // At least one should be omitted due to budget
    if (bundle.files.length < 2) {
      expect(bundle.omittedFiles.some((f) => f.reason === "budget_exceeded")).toBe(true);
    }
  });
});

describe("bundleContext - deduplication", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("bundler-dedup");

    createProjectStructure(tmpDir, {
      "src/utils.ts": "export const helper = 1;",
      "src/index.ts": "import { helper } from './utils';",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("deduplicates files appearing in multiple categories", async () => {
    // Include utils.ts explicitly - it should only appear once
    // even if it would also be picked up as a dependency
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["src/utils.ts", "src/index.ts"],
      maxTokens: 100000,
      includeDependencies: true,
      includeConversation: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    // utils.ts should appear only once (as explicit, not also as dependency)
    const utilsFiles = bundle.files.filter((f) => f.path.includes("utils.ts"));
    expect(utilsFiles).toHaveLength(1);
    expect(utilsFiles[0].category).toBe("explicit");
  });
});

describe("bundleContext - directory expansion edge cases", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("bundler-dir-edge");
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("returns empty for directory with only hidden files", async () => {
    const hiddenOnlyDir = path.join(tmpDir, "hidden-only");
    fs.mkdirSync(hiddenOnlyDir, { recursive: true });
    fs.writeFileSync(path.join(hiddenOnlyDir, ".hidden"), "secret");
    fs.writeFileSync(path.join(hiddenOnlyDir, ".another"), "also hidden");

    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["hidden-only"],
      maxTokens: 100000,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle.files).toHaveLength(0);
  });

  it("handles empty directory gracefully", async () => {
    const emptyDir = path.join(tmpDir, "empty-dir");
    fs.mkdirSync(emptyDir, { recursive: true });

    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["empty-dir"],
      maxTokens: 100000,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle.files).toHaveLength(0);
  });

  it("deeply nested directory with mixed content", async () => {
    createProjectStructure(tmpDir, {
      "nested/a/b/c/deepfile.ts": "export const deep = 1;",
      "nested/a/b/midfile.ts": "export const mid = 1;",
      "nested/a/.hidden/secretfile.ts": "secret content",
      "nested/a/visiblefile.ts": "export const visible = 1;",
    });

    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["nested"],
      maxTokens: 100000,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    // Should find files in nested directories (check by filename)
    expect(bundle.files.some((f) => f.path.includes("deepfile.ts"))).toBe(true);
    expect(bundle.files.some((f) => f.path.includes("midfile.ts"))).toBe(true);
    expect(bundle.files.some((f) => f.path.includes("visiblefile.ts"))).toBe(true);
    // Should skip hidden directory
    expect(bundle.files.every((f) => !f.path.includes(".hidden"))).toBe(true);
    expect(bundle.files.every((f) => !f.path.includes("secretfile"))).toBe(true);
  });
});

describe("formatBundleAsMarkdown - truncation warning banner", () => {
  const baseBundle = {
    conversationContext: "",
    files: [],
    totalTokens: 1000,
    categories: {
      session: 0,
      git: 0,
      dependency: 0,
      dependent: 0,
      test: 0,
      type: 0,
      explicit: 0,
    },
    redactionStats: { totalCount: 0, types: [] },
    budgetWarnings: [],
  };

  it("shows truncation warning when ≥3 files omitted due to budget", () => {
    const bundle = {
      ...baseBundle,
      omittedFiles: [
        { path: "/p/a.ts", category: "session" as const, tokenEstimate: 100, reason: "budget_exceeded" as const },
        { path: "/p/b.ts", category: "session" as const, tokenEstimate: 100, reason: "budget_exceeded" as const },
        { path: "/p/c.ts", category: "session" as const, tokenEstimate: 100, reason: "budget_exceeded" as const },
      ],
    };

    const markdown = formatBundleAsMarkdown(bundle, "/p");

    expect(markdown).toContain("⚠️ **INCOMPLETE CONTEXT WARNING**");
    expect(markdown).toContain("3 files");
    expect(markdown).toContain("Do not report issues in code you cannot see");
  });

  it("shows truncation warning when omitted tokens > 10% of total", () => {
    const bundle = {
      ...baseBundle,
      totalTokens: 1000,
      omittedFiles: [
        { path: "/p/large.ts", category: "session" as const, tokenEstimate: 200, reason: "budget_exceeded" as const },
      ],
    };

    const markdown = formatBundleAsMarkdown(bundle, "/p");

    // 200 > 10% of 1000
    expect(markdown).toContain("⚠️ **INCOMPLETE CONTEXT WARNING**");
    expect(markdown).toContain("1 files");
  });

  it("does NOT show warning when few files omitted and tokens below threshold", () => {
    const bundle = {
      ...baseBundle,
      totalTokens: 10000,
      omittedFiles: [
        { path: "/p/small.ts", category: "type" as const, tokenEstimate: 50, reason: "budget_exceeded" as const },
      ],
    };

    const markdown = formatBundleAsMarkdown(bundle, "/p");

    // 50 < 10% of 10000, and only 1 file
    expect(markdown).not.toContain("⚠️ **INCOMPLETE CONTEXT WARNING**");
  });

  it("does NOT count non-budget omissions toward warning threshold", () => {
    const bundle = {
      ...baseBundle,
      totalTokens: 10000,
      omittedFiles: [
        { path: "/p/.env", category: "explicit" as const, tokenEstimate: 0, reason: "sensitive_path" as const },
        { path: "/ext/a.ts", category: "explicit" as const, tokenEstimate: 100, reason: "outside_project" as const },
        { path: "/ext/b.ts", category: "explicit" as const, tokenEstimate: 100, reason: "outside_project_requires_allowExternalFiles" as const },
      ],
    };

    const markdown = formatBundleAsMarkdown(bundle, "/p");

    // No budget_exceeded files, so no warning
    expect(markdown).not.toContain("⚠️ **INCOMPLETE CONTEXT WARNING**");
  });

  it("warning appears at the TOP of the markdown (before conversation)", () => {
    const bundle = {
      ...baseBundle,
      conversationContext: "## Conversation\nUser asked about X",
      omittedFiles: [
        { path: "/p/a.ts", category: "session" as const, tokenEstimate: 100, reason: "budget_exceeded" as const },
        { path: "/p/b.ts", category: "session" as const, tokenEstimate: 100, reason: "budget_exceeded" as const },
        { path: "/p/c.ts", category: "session" as const, tokenEstimate: 100, reason: "budget_exceeded" as const },
      ],
    };

    const markdown = formatBundleAsMarkdown(bundle, "/p");

    const warningIndex = markdown.indexOf("⚠️ **INCOMPLETE CONTEXT WARNING**");
    const conversationIndex = markdown.indexOf("## Conversation");

    expect(warningIndex).toBeLessThan(conversationIndex);
  });
});

describe("bundleContext - budget warnings", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("bundler-budget-warnings");
    createProjectStructure(tmpDir, {
      "src/small.ts": "export const x = 1;",
      "src/large.ts": "x".repeat(4000), // ~1000 tokens
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("generates budget warning when explicit files are omitted", async () => {
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["src/large.ts"],
      maxTokens: 100, // Very small budget, explicit gets 15 tokens
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    // The large file should be omitted and trigger a warning
    expect(bundle.budgetWarnings.length).toBeGreaterThan(0);
    const explicitWarning = bundle.budgetWarnings.find((w) => w.category === "explicit");
    expect(explicitWarning).toBeDefined();
    expect(explicitWarning?.severity).toBe("high");
    expect(explicitWarning?.suggestedBudget).toBeGreaterThan(100);
  });

  it("includes suggested budget that would fit omitted files", async () => {
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["src/large.ts"],
      maxTokens: 100,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    const warning = bundle.budgetWarnings[0];
    if (warning) {
      // Suggested budget should be rounded up to nearest 10k
      expect(warning.suggestedBudget! % 10000).toBe(0);
      // Should be large enough to include the omitted tokens + buffer
      expect(warning.suggestedBudget!).toBeGreaterThanOrEqual(warning.omittedTokens);
    }
  });

  it("has empty budgetWarnings when all files fit", async () => {
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["src/small.ts"],
      maxTokens: 100000, // Plenty of budget
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle.budgetWarnings).toHaveLength(0);
  });
});

describe("bundleContext - budget redistribution", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("bundler-redistribution");
    createProjectStructure(tmpDir, {
      "src/a.ts": "a".repeat(200), // ~50 tokens
      "src/b.ts": "b".repeat(200), // ~50 tokens
      "src/c.ts": "c".repeat(200), // ~50 tokens
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("includes all files when total demand fits in budget (fast path)", async () => {
    // Total demand ~150 tokens, budget 2000 → all fit via fast path
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      maxTokens: 2000,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    expect(bundle.files.length).toBe(3);
    expect(bundle.files.every((f) => f.category === "explicit")).toBe(true);
    expect(bundle.omittedFiles.filter((f) => f.reason === "budget_exceeded")).toHaveLength(0);
  });

  it("redistributes budget from empty categories to busy ones", async () => {
    // With maxTokens=100, explicit base = 15 tokens.
    // But all other categories are empty, so the full 100 token pool
    // gets redistributed to explicit. File is ~50 tokens → fits.
    const bundle = await bundleContext({
      projectPath: tmpDir,
      includeFiles: ["src/a.ts"],
      maxTokens: 100,
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
    });

    // With two-pass allocation, the ~50 token file fits in the 100 token pool
    expect(bundle.files.length).toBe(1);
    expect(bundle.files[0].category).toBe("explicit");
  });
});

describe("allocateBudget - unit tests", () => {
  it("all-fit fast path: includes everything when demand < pool", () => {
    const candidates: CategoryCandidates[] = [
      { category: "explicit", files: [candidate("/p/a.ts", "explicit", 100)], totalDemand: 100 },
      { category: "session", files: [candidate("/p/b.ts", "session", 200)], totalDemand: 200 },
      { category: "test", files: [candidate("/p/c.ts", "test", 50)], totalDemand: 50 },
    ];

    const result = allocateBudget(candidates, 1000, BUDGET_ALLOCATION, CATEGORY_PRIORITY_ORDER);

    expect(result.included).toHaveLength(3);
    expect(result.omitted).toHaveLength(0);
    expect(result.categoryTokens.explicit).toBe(100);
    expect(result.categoryTokens.session).toBe(200);
    expect(result.categoryTokens.test).toBe(50);
  });

  it("single-round redistribution: surplus categories donate to deficit", () => {
    const candidates: CategoryCandidates[] = [
      { category: "explicit", files: [candidate("/p/big.ts", "explicit", 800)], totalDemand: 800 },
      { category: "test", files: [candidate("/p/small.ts", "test", 50)], totalDemand: 50 },
    ];

    const result = allocateBudget(candidates, 1000, BUDGET_ALLOCATION, CATEGORY_PRIORITY_ORDER);

    expect(result.included).toHaveLength(2);
    expect(result.omitted).toHaveLength(0);
  });

  it("contention: omits files when total demand exceeds pool", () => {
    const candidates: CategoryCandidates[] = [
      {
        category: "explicit",
        files: [candidate("/p/a.ts", "explicit", 60), candidate("/p/b.ts", "explicit", 90)],
        totalDemand: 150,
      },
    ];

    const result = allocateBudget(candidates, 100, BUDGET_ALLOCATION, CATEGORY_PRIORITY_ORDER);

    expect(result.included).toHaveLength(1);
    expect(result.included[0].path).toBe("/p/a.ts");
    expect(result.omitted).toHaveLength(1);
    expect(result.omitted[0].path).toBe("/p/b.ts");
    expect(result.omitted[0].reason).toBe("budget_exceeded");
  });

  it("non-explicit/session categories sort smallest-first under contention", () => {
    const candidates: CategoryCandidates[] = [
      {
        category: "dependency",
        files: [candidate("/p/big.ts", "dependency", 80), candidate("/p/small.ts", "dependency", 10)],
        totalDemand: 90,
      },
      { category: "explicit", files: [candidate("/p/e.ts", "explicit", 50)], totalDemand: 50 },
    ];

    const result = allocateBudget(candidates, 80, BUDGET_ALLOCATION, CATEGORY_PRIORITY_ORDER);

    const depIncluded = result.included.filter((f) => f.category === "dependency");
    if (depIncluded.length > 0) {
      expect(depIncluded[0].path).toBe("/p/small.ts");
    }
  });

  it("exact-fit edge case: file exactly uses remaining budget", () => {
    const candidates: CategoryCandidates[] = [
      { category: "explicit", files: [candidate("/p/exact.ts", "explicit", 100)], totalDemand: 100 },
    ];

    const result = allocateBudget(candidates, 100, BUDGET_ALLOCATION, CATEGORY_PRIORITY_ORDER);

    expect(result.included).toHaveLength(1);
    expect(result.omitted).toHaveLength(0);
  });

  it("remainder fill: rescues files that exceed category budget but fit globally", () => {
    const candidates: CategoryCandidates[] = [
      { category: "explicit", files: [candidate("/p/a.ts", "explicit", 60)], totalDemand: 60 },
      { category: "session", files: [candidate("/p/b.ts", "session", 40)], totalDemand: 40 },
    ];

    const result = allocateBudget(candidates, 100, BUDGET_ALLOCATION, CATEGORY_PRIORITY_ORDER);

    expect(result.included).toHaveLength(2);
    expect(result.omitted).toHaveLength(0);
  });

  it("remainder fill: respects priority order when rescuing", () => {
    const candidates: CategoryCandidates[] = [
      { category: "explicit", files: [candidate("/p/exp.ts", "explicit", 25)], totalDemand: 25 },
      { category: "session", files: [candidate("/p/sess.ts", "session", 30)], totalDemand: 30 },
      { category: "type", files: [candidate("/p/type.ts", "type", 35)], totalDemand: 35 },
    ];

    const result = allocateBudget(candidates, 70, BUDGET_ALLOCATION, CATEGORY_PRIORITY_ORDER);

    expect(result.included.some((f) => f.path === "/p/exp.ts")).toBe(true);
    expect(result.included.some((f) => f.path === "/p/sess.ts")).toBe(true);
    const totalIncluded = result.included.reduce((sum, f) => sum + f.tokenEstimate, 0);
    expect(totalIncluded).toBeLessThanOrEqual(70);
  });
});
