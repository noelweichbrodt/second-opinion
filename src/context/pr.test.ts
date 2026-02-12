import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "child_process";
import { isGhAvailable, detectPR, formatPRMetadata, getPRChangedFiles, PRContext, PRDetectionResult } from "./pr.js";

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof childProcess>("child_process");
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

const mockSpawnSync = vi.mocked(childProcess.spawnSync);

/** Build a minimal SpawnSyncReturns mock with sensible defaults */
function spawnResult(overrides: {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}): childProcess.SpawnSyncReturns<string> {
  return {
    status: overrides.status ?? 0,
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
    pid: 1,
    output: [],
    signal: null,
    ...(overrides.error ? { error: overrides.error } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isGhAvailable", () => {
  it("returns true when gh is installed", () => {
    mockSpawnSync.mockReturnValueOnce(spawnResult({ stdout: "gh version 2.40.0" }));

    expect(isGhAvailable()).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledWith("gh", ["--version"], expect.any(Object));
  });

  it("returns false when gh is not installed", () => {
    mockSpawnSync.mockReturnValueOnce(
      spawnResult({ status: 1, stderr: "command not found", error: new Error("ENOENT") })
    );

    expect(isGhAvailable()).toBe(false);
  });
});

describe("detectPR", () => {
  function mockGhAvailable(): void {
    mockSpawnSync.mockReturnValueOnce(spawnResult({ stdout: "gh version 2.40.0" }));
  }

  const samplePRData = {
    number: 42,
    title: "Add login feature",
    body: "This PR adds OAuth login support.",
    url: "https://github.com/org/repo/pull/42",
    state: "OPEN",
    baseRefName: "main",
    headRefName: "feature/login",
    labels: [{ name: "enhancement" }, { name: "auth" }],
    comments: [
      {
        author: { login: "reviewer1" },
        body: "Looks good overall",
        createdAt: "2025-01-15T10:00:00Z",
      },
    ],
    reviews: [
      {
        author: { login: "reviewer2" },
        body: "Please add tests",
        state: "CHANGES_REQUESTED",
        createdAt: "2025-01-15T11:00:00Z",
      },
    ],
    files: [{ path: "src/auth.ts" }, { path: "src/login.ts" }],
  };

  function mockPRView(data: unknown): void {
    mockSpawnSync.mockReturnValueOnce(spawnResult({ stdout: JSON.stringify(data) }));
  }

  it("returns gh_not_installed when gh is not available", () => {
    mockSpawnSync.mockReturnValueOnce(
      spawnResult({ status: 1, error: new Error("ENOENT") })
    );

    const result = detectPR("/project");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("gh_not_installed");
      expect(result.message).toContain("https://cli.github.com/");
    }
  });

  it("returns no_pr_found when no PR exists for current branch", () => {
    mockGhAvailable();
    mockSpawnSync.mockReturnValueOnce(
      spawnResult({ status: 1, stderr: "no pull requests found" })
    );

    const result = detectPR("/project");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_pr_found");
    }
  });

  it("returns gh_command_failed on other gh errors", () => {
    mockGhAvailable();
    mockSpawnSync.mockReturnValueOnce(
      spawnResult({ status: 1, stderr: "HTTP 403: Resource not accessible by integration" })
    );

    const result = detectPR("/project");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("gh_command_failed");
      expect(result.message).toContain("403");
    }
  });

  it("parses gh pr view output correctly", () => {
    mockGhAvailable();
    mockPRView(samplePRData);

    const result = detectPR("/project");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pr.number).toBe(42);
    expect(result.pr.title).toBe("Add login feature");
    expect(result.pr.body).toBe("This PR adds OAuth login support.");
    expect(result.pr.url).toBe("https://github.com/org/repo/pull/42");
    expect(result.pr.state).toBe("OPEN");
    expect(result.pr.baseBranch).toBe("main");
    expect(result.pr.headBranch).toBe("feature/login");
    expect(result.pr.labels).toEqual(["enhancement", "auth"]);
    expect(result.pr.comments).toHaveLength(1);
    expect(result.pr.comments[0].author).toBe("reviewer1");
    expect(result.pr.reviews).toHaveLength(1);
    expect(result.pr.reviews[0].state).toBe("CHANGES_REQUESTED");
    expect(result.pr.changedFiles).toEqual(["/project/src/auth.ts", "/project/src/login.ts"]);
  });

  it("passes prNumber to gh when provided", () => {
    mockGhAvailable();
    mockPRView(samplePRData);

    detectPR("/project", 99);

    // Second call (first is gh --version)
    const prViewCall = mockSpawnSync.mock.calls[1];
    expect(prViewCall[0]).toBe("gh");
    expect(prViewCall[1]).toContain("99");
  });

  it("auto-detects PR when prNumber is omitted", () => {
    mockGhAvailable();
    mockPRView(samplePRData);

    detectPR("/project");

    const prViewCall = mockSpawnSync.mock.calls[1];
    expect(prViewCall[1]).toEqual(
      expect.arrayContaining(["pr", "view", "--json"])
    );
    // Should NOT contain a PR number argument
    expect(prViewCall[1]).not.toContain(expect.stringMatching(/^\d+$/));
  });

  it("returns parse_error on malformed JSON", () => {
    mockGhAvailable();
    mockSpawnSync.mockReturnValueOnce(spawnResult({ stdout: "not valid json" }));

    const result = detectPR("/project");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("parse_error");
    }
  });

  it("handles missing optional fields gracefully", () => {
    mockGhAvailable();
    mockPRView({ number: 1 });

    const result = detectPR("/project");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pr.title).toBe("");
    expect(result.pr.labels).toEqual([]);
    expect(result.pr.comments).toEqual([]);
    expect(result.pr.reviews).toEqual([]);
    expect(result.pr.changedFiles).toEqual([]);
  });

  it("falls back to getPRChangedFiles when gh returns empty files", () => {
    mockGhAvailable();
    mockPRView({ ...samplePRData, files: [] });
    // Mock git diff call for fallback
    mockSpawnSync.mockReturnValueOnce(
      spawnResult({ stdout: "src/fallback.ts\n" })
    );

    const result = detectPR("/project");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pr.changedFiles).toEqual(["/project/src/fallback.ts"]);
  });
});

describe("getPRChangedFiles", () => {
  it("returns absolute paths from git diff output", () => {
    mockSpawnSync.mockReturnValueOnce(
      spawnResult({ stdout: "src/auth.ts\nsrc/login.ts\n" })
    );

    const files = getPRChangedFiles("/project", "main");

    expect(files).toEqual(["/project/src/auth.ts", "/project/src/login.ts"]);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "git",
      ["diff", "main...HEAD", "--name-only"],
      expect.any(Object)
    );
  });

  it("returns empty array on git failure", () => {
    mockSpawnSync.mockReturnValueOnce(
      spawnResult({ status: 1, stderr: "fatal: bad revision" })
    );

    expect(getPRChangedFiles("/project", "main")).toEqual([]);
  });
});

describe("formatPRMetadata", () => {
  const basePR: PRContext = {
    number: 42,
    title: "Add login feature",
    body: "This PR adds OAuth login support.",
    url: "https://github.com/org/repo/pull/42",
    state: "OPEN",
    baseBranch: "main",
    headBranch: "feature/login",
    labels: ["enhancement"],
    comments: [
      {
        author: "reviewer1",
        body: "Looks good overall",
        createdAt: "2025-01-15T10:00:00Z",
      },
    ],
    reviews: [
      {
        author: "reviewer2",
        body: "Please add tests",
        state: "CHANGES_REQUESTED",
        createdAt: "2025-01-15T11:00:00Z",
      },
    ],
    changedFiles: ["/project/src/auth.ts"],
  };

  it("includes PR number and title", () => {
    const md = formatPRMetadata(basePR);
    expect(md).toContain("Pull Request #42");
    expect(md).toContain("Add login feature");
  });

  it("includes PR metadata fields", () => {
    const md = formatPRMetadata(basePR);
    expect(md).toContain("OPEN");
    expect(md).toContain("main");
    expect(md).toContain("feature/login");
    expect(md).toContain("enhancement");
  });

  it("includes PR body", () => {
    const md = formatPRMetadata(basePR);
    expect(md).toContain("OAuth login support");
  });

  it("includes comments", () => {
    const md = formatPRMetadata(basePR);
    expect(md).toContain("reviewer1");
    expect(md).toContain("Looks good overall");
  });

  it("includes reviews", () => {
    const md = formatPRMetadata(basePR);
    expect(md).toContain("reviewer2");
    expect(md).toContain("CHANGES_REQUESTED");
    expect(md).toContain("Please add tests");
  });

  it("redacts secrets in PR body", () => {
    const prWithSecret: PRContext = {
      ...basePR,
      body: "Set OPENAI_API_KEY=sk-1234567890abcdefghijklmnop in .env",
    };
    const md = formatPRMetadata(prWithSecret);
    expect(md).not.toContain("sk-1234567890abcdefghijklmnop");
    expect(md).toContain("[REDACTED");
  });

  it("redacts secrets in comments", () => {
    const prWithSecret: PRContext = {
      ...basePR,
      comments: [
        {
          author: "user",
          body: "Use token ghp_abcdefghijklmnopqrstuvwxyz1234567890abcdef",
          createdAt: "2025-01-15T10:00:00Z",
        },
      ],
    };
    const md = formatPRMetadata(prWithSecret);
    expect(md).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890abcdef");
  });

  it("handles empty body, comments, and reviews", () => {
    const minimalPR: PRContext = {
      ...basePR,
      body: "",
      comments: [],
      reviews: [],
    };
    const md = formatPRMetadata(minimalPR);
    expect(md).toContain("Pull Request #42");
    expect(md).not.toContain("Description");
    expect(md).not.toContain("Discussion Comments");
    expect(md).not.toContain("Reviews");
  });
});
