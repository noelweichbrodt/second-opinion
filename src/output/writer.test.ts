import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  writeReview,
  writeEgressManifest,
  deriveSessionName,
  ReviewMetadata,
  EgressSummary,
} from "./writer.js";

describe("deriveSessionName", () => {
  it("extracts name from first user message", () => {
    const context = "## Conversation Context\n\n**User**:\nFix the login bug\n\n**Claude**:\nI'll look into it.";
    expect(deriveSessionName(context)).toBe("Fix the login bug");
  });

  it("truncates long messages", () => {
    const longMessage = "A".repeat(100);
    const context = `**User**:\n${longMessage}\n`;
    const result = deriveSessionName(context);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it("returns fallback for empty context", () => {
    expect(deriveSessionName("")).toBe("review");
    expect(deriveSessionName("", "custom-fallback")).toBe("custom-fallback");
  });

  it("returns fallback for context without user message", () => {
    const context = "**Claude**:\nHere's the review.";
    expect(deriveSessionName(context)).toBe("review");
  });

  it("strips special characters from name", () => {
    const context = "**User**:\nFix the `bug` in [auth]!\n";
    const result = deriveSessionName(context);
    expect(result).not.toContain("`");
    expect(result).not.toContain("[");
    expect(result).not.toContain("!");
  });
});

describe("writeReview", () => {
  const tmpDir = path.join(os.tmpdir(), "writer-test-" + Date.now());

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates review file with correct filename for review", () => {
    const metadata: ReviewMetadata = {
      sessionName: "Fix Login Bug",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [],
    };

    const filePath = writeReview(tmpDir, "reviews", metadata, "# Review\nLooks good!");

    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toContain("fix-login-bug.gemini.review.md");
  });

  it("creates review file with task slug when task provided", () => {
    const metadata: ReviewMetadata = {
      sessionName: "Auth Refactor",
      provider: "openai",
      model: "gpt-4o",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [],
      task: "Check for security vulnerabilities in the authentication flow",
    };

    const filePath = writeReview(tmpDir, "reviews", metadata, "# Analysis\nNo issues found.");

    expect(filePath).toContain("auth-refactor.openai.check-for-security");
    expect(filePath.endsWith(".md")).toBe(true);
  });

  it("creates output directory if it doesn't exist", () => {
    const metadata: ReviewMetadata = {
      sessionName: "Test",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [],
    };

    const filePath = writeReview(tmpDir, "new-dir", metadata, "Review content");

    expect(fs.existsSync(path.join(tmpDir, "new-dir"))).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("includes metadata in review content", () => {
    const metadata: ReviewMetadata = {
      sessionName: "Metadata Test",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [path.join(tmpDir, "src", "file.ts")],
      tokensUsed: 1000,
    };

    const filePath = writeReview(tmpDir, "reviews", metadata, "Review body");
    const content = fs.readFileSync(filePath, "utf-8");

    expect(content).toContain("**Provider:** gemini (gemini-2.0-flash-exp)");
    expect(content).toContain("**Date:** 2024-01-01T00:00:00Z");
    expect(content).toContain("**Tokens Used:** 1,000");
    expect(content).toContain("Review body");
  });

  it("throws on absolute reviewsDir", () => {
    const metadata: ReviewMetadata = {
      sessionName: "Test",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [],
    };

    expect(() => writeReview(tmpDir, "/absolute/path", metadata, "content")).toThrow(
      "reviewsDir must be relative"
    );
  });

  it("throws on path traversal in reviewsDir", () => {
    const metadata: ReviewMetadata = {
      sessionName: "Test",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [],
    };

    expect(() => writeReview(tmpDir, "../escape", metadata, "content")).toThrow(
      "path traversal"
    );
  });
});

describe("writeEgressManifest", () => {
  const tmpDir = path.join(os.tmpdir(), "egress-test-" + Date.now());

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates egress manifest with correct structure", () => {
    const metadata: ReviewMetadata = {
      sessionName: "Egress Test",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [],
    };

    const egressData: EgressSummary = {
      projectFilesSent: 5,
      projectFilePaths: [
        path.join(tmpDir, "src/a.ts"),
        path.join(tmpDir, "src/b.ts"),
      ],
      externalFilesSent: 1,
      externalFilePaths: ["/external/file.ts"],
      externalLocations: ["/external"],
      blockedFiles: [{ path: "/blocked/secret.ts", reason: "sensitive_path" }],
      provider: "gemini",
    };

    const filePath = writeEgressManifest(tmpDir, "reviews", metadata, egressData);

    expect(filePath).toContain("egress-test.gemini.review.egress.json");

    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.timestamp).toBe("2024-01-01T00:00:00Z");
    expect(content.provider).toBe("gemini");
    expect(content.egress.projectFiles.count).toBe(5);
    expect(content.egress.externalFiles.count).toBe(1);
    expect(content.egress.blockedFiles).toHaveLength(1);
    expect(content.egress.totalFilesSent).toBe(6);
  });

  it("relativizes project file paths", () => {
    const metadata: ReviewMetadata = {
      sessionName: "Path Test",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [],
    };

    const egressData: EgressSummary = {
      projectFilesSent: 1,
      projectFilePaths: [path.join(tmpDir, "src", "file.ts")],
      externalFilesSent: 0,
      externalFilePaths: [],
      externalLocations: [],
      blockedFiles: [],
      provider: "gemini",
    };

    const filePath = writeEgressManifest(tmpDir, "reviews", metadata, egressData);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));

    // Should be relative path, not absolute
    expect(content.egress.projectFiles.paths[0]).toBe(path.join("src", "file.ts"));
  });
});

// Test internal functions through their effects on writeReview output
describe("writeReview - filename generation", () => {
  const tmpDir = path.join(os.tmpdir(), "writer-filename-test-" + Date.now());

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("slugifies session name to lowercase with hyphens", () => {
    const metadata: ReviewMetadata = {
      sessionName: "My Complex Session NAME",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [],
    };

    const filePath = writeReview(tmpDir, "reviews", metadata, "content");

    expect(filePath).toContain("my-complex-session-name.gemini.review.md");
  });

  it("removes non-alphanumeric characters from slug", () => {
    const metadata: ReviewMetadata = {
      sessionName: "Fix [Bug] in `auth`!",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [],
    };

    const filePath = writeReview(tmpDir, "reviews", metadata, "content");

    expect(filePath).not.toContain("[");
    expect(filePath).not.toContain("]");
    expect(filePath).not.toContain("`");
    expect(filePath).not.toContain("!");
    expect(filePath).toContain("fix-bug-in-auth");
  });

  it("truncates long session names in slug", () => {
    const metadata: ReviewMetadata = {
      sessionName: "A".repeat(100),
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [],
    };

    const filePath = writeReview(tmpDir, "reviews", metadata, "content");
    const filename = path.basename(filePath);

    // Slug should be truncated (50 chars max) + .gemini.review.md
    expect(filename.length).toBeLessThan(100);
  });

  it("derives task slug from task description", () => {
    const metadata: ReviewMetadata = {
      sessionName: "Session",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [],
      task: "Evaluate the error handling strategy and find gaps",
    };

    const filePath = writeReview(tmpDir, "reviews", metadata, "content");

    // Should extract first few meaningful words
    expect(filePath).toContain("evaluate-the-error-handling");
  });

  it("handles task with mostly short words", () => {
    const metadata: ReviewMetadata = {
      sessionName: "Session",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [],
      task: "Do it now",
    };

    const filePath = writeReview(tmpDir, "reviews", metadata, "content");

    // Words 2 chars or less should be filtered
    expect(filePath).toContain("now");
  });

  it("uses 'task' for empty task description", () => {
    const metadata: ReviewMetadata = {
      sessionName: "Session",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [],
      task: "  ",
    };

    const filePath = writeReview(tmpDir, "reviews", metadata, "content");

    expect(filePath).toContain("session.gemini.task.md");
  });
});

describe("writeReview - reviewsDir validation", () => {
  const tmpDir = path.join(os.tmpdir(), "writer-validation-test-" + Date.now());

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const metadata: ReviewMetadata = {
    sessionName: "Test",
    provider: "gemini",
    model: "gemini-2.0-flash-exp",
    timestamp: "2024-01-01T00:00:00Z",
    filesReviewed: [],
  };

  it("allows simple relative paths", () => {
    expect(() => writeReview(tmpDir, "reviews", metadata, "content")).not.toThrow();
    expect(() => writeReview(tmpDir, "output", metadata, "content")).not.toThrow();
  });

  it("allows nested relative paths", () => {
    expect(() => writeReview(tmpDir, "output/reviews", metadata, "content")).not.toThrow();
  });

  it("rejects absolute paths starting with /", () => {
    expect(() => writeReview(tmpDir, "/tmp/reviews", metadata, "content")).toThrow(
      "reviewsDir must be relative"
    );
  });

  it("rejects paths with .. at start", () => {
    expect(() => writeReview(tmpDir, "../reviews", metadata, "content")).toThrow(
      "path traversal"
    );
  });

  it("rejects paths with .. in middle", () => {
    expect(() => writeReview(tmpDir, "foo/../bar", metadata, "content")).toThrow(
      "path traversal"
    );
  });

  it("rejects paths that normalize to traverse out", () => {
    expect(() => writeReview(tmpDir, "foo/../../bar", metadata, "content")).toThrow(
      "path traversal"
    );
  });
});

describe("writeReview - content structure", () => {
  const tmpDir = path.join(os.tmpdir(), "writer-content-test-" + Date.now());

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes header for review mode", () => {
    const metadata: ReviewMetadata = {
      sessionName: "My Review",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [],
    };

    const filePath = writeReview(tmpDir, "reviews", metadata, "Review body");
    const content = fs.readFileSync(filePath, "utf-8");

    expect(content).toContain("# Code Review - My Review");
  });

  it("includes header with task for task mode", () => {
    const metadata: ReviewMetadata = {
      sessionName: "My Task",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [],
      task: "Analyze the code for issues",
    };

    const filePath = writeReview(tmpDir, "reviews", metadata, "Task output");
    const content = fs.readFileSync(filePath, "utf-8");

    expect(content).toContain("# Second Opinion - My Task");
    expect(content).toContain("**Task:** Analyze the code for issues");
  });

  it("truncates long task descriptions in header", () => {
    const longTask = "A".repeat(300);
    const metadata: ReviewMetadata = {
      sessionName: "Test",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [],
      task: longTask,
    };

    const filePath = writeReview(tmpDir, "reviews", metadata, "output");
    const content = fs.readFileSync(filePath, "utf-8");

    expect(content).toContain("...");
    expect(content.indexOf("**Task:**")).toBeLessThan(content.indexOf("..."));
  });

  it("lists files reviewed when present", () => {
    const metadata: ReviewMetadata = {
      sessionName: "Test",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [
        path.join(tmpDir, "src", "index.ts"),
        path.join(tmpDir, "src", "utils.ts"),
      ],
    };

    const filePath = writeReview(tmpDir, "reviews", metadata, "output");
    const content = fs.readFileSync(filePath, "utf-8");

    expect(content).toContain("## Files Analyzed");
    expect(content).toContain("- src/index.ts");
    expect(content).toContain("- src/utils.ts");
  });

  it("omits files section when no files reviewed", () => {
    const metadata: ReviewMetadata = {
      sessionName: "Test",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [],
    };

    const filePath = writeReview(tmpDir, "reviews", metadata, "output");
    const content = fs.readFileSync(filePath, "utf-8");

    expect(content).not.toContain("## Files Analyzed");
  });

  it("includes generation footer", () => {
    const metadata: ReviewMetadata = {
      sessionName: "Test",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      timestamp: "2024-01-01T00:00:00Z",
      filesReviewed: [],
    };

    const filePath = writeReview(tmpDir, "reviews", metadata, "output");
    const content = fs.readFileSync(filePath, "utf-8");

    expect(content).toContain("*Generated by second-opinion MCP server*");
  });
});
