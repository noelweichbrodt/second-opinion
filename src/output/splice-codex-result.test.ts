import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { spliceCodexResult } from "./splice-codex-result.js";
import { CODEX_REVIEW_PLACEHOLDER } from "../providers/codex.js";
import { createTempDir, cleanupTempDir } from "../test-utils.js";

// Fault injection for the byte-fidelity guard: when enabled, writeSync
// silently truncates string writes — the exact failure the pre-rename
// verification exists to catch. ESM namespace exports cannot be spied on,
// so the module itself is mocked (same pattern as the os mock in
// config.test.ts).
const fsMock = vi.hoisted(() => ({ truncateWrites: false }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    writeSync: ((fd: number, data: unknown, ...rest: unknown[]) => {
      if (fsMock.truncateWrites && typeof data === "string") {
        return (actual.writeSync as CallableFunction)(
          fd,
          data.slice(0, 10),
          ...rest
        );
      }
      return (actual.writeSync as CallableFunction)(fd, data, ...rest);
    }) as typeof actual.writeSync,
  };
});

const JOB_ID = "task-abc123-def456";

describe("spliceCodexResult", () => {
  let tmpDir: string;
  let stateRoot: string;
  let reviewFile: string;

  beforeEach(() => {
    tmpDir = createTempDir("splice");
    stateRoot = path.join(tmpDir, "state");
    fs.mkdirSync(path.join(stateRoot, "workspace-slug", "jobs"), {
      recursive: true,
    });
    reviewFile = path.join(tmpDir, "session.codex.review.md");
    fs.writeFileSync(
      reviewFile,
      `# Review\n\n## Codex Review\n\n${CODEX_REVIEW_PLACEHOLDER}\n`
    );
  });

  afterEach(() => {
    fsMock.truncateWrites = false;
    cleanupTempDir(tmpDir);
  });

  function writeJob(job: unknown, id: string = JOB_ID, slug = "workspace-slug"): void {
    const dir = path.join(stateRoot, slug, "jobs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(job));
  }

  function opts() {
    return { stateRoots: [stateRoot] };
  }

  it("splices rawOutput byte-for-byte, preserving unicode, fences, $, and HTML comments", () => {
    const rawOutput =
      "## Summary\n\nRévision — done ✅\n\n```ts\nconst x = `a${1}b`; // $& $' $1\n```\n\n<!-- html comment -->\ntrailing\n";
    writeJob({ status: "completed", result: { rawOutput } });

    const result = spliceCodexResult(JOB_ID, reviewFile, opts());
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^OK spliced \d+ B sha256=[0-9a-f]{12}$/);
    expect(result.message.length).toBeLessThanOrEqual(200);

    const written = fs.readFileSync(reviewFile, "utf-8");
    expect(written).toBe(`# Review\n\n## Codex Review\n\n${rawOutput}\n`);
    expect(written).not.toContain(CODEX_REVIEW_PLACEHOLDER);
  });

  it("fails when the job is missing", () => {
    const result = spliceCodexResult("task-unknown", reviewFile, opts());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
    expect(fs.readFileSync(reviewFile, "utf-8")).toContain(CODEX_REVIEW_PLACEHOLDER);
  });

  it("fails when the job id matches multiple state entries", () => {
    writeJob({ status: "completed", result: { rawOutput: "review" } });
    writeJob({ status: "completed", result: { rawOutput: "review" } }, JOB_ID, "other-slug");
    const result = spliceCodexResult(JOB_ID, reviewFile, opts());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("ambiguous");
    expect(fs.readFileSync(reviewFile, "utf-8")).toContain(CODEX_REVIEW_PLACEHOLDER);
  });

  it("fails when the job is not completed", () => {
    writeJob({ status: "running", result: {} });
    const result = spliceCodexResult(JOB_ID, reviewFile, opts());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("running");
    expect(fs.readFileSync(reviewFile, "utf-8")).toContain(CODEX_REVIEW_PLACEHOLDER);
  });

  it("fails closed on plugin state shape drift", () => {
    for (const job of [
      { status: "completed" },
      { status: "completed", result: {} },
      { status: "completed", result: { rawOutput: 42 } },
      { status: "completed", result: { rawOutput: "   " } },
    ]) {
      writeJob(job);
      const result = spliceCodexResult(JOB_ID, reviewFile, opts());
      expect(result.ok).toBe(false);
      expect(result.message).toContain("rawOutput");
      expect(fs.readFileSync(reviewFile, "utf-8")).toContain(
        CODEX_REVIEW_PLACEHOLDER
      );
    }
  });

  it("fails on corrupt job JSON", () => {
    const dir = path.join(stateRoot, "workspace-slug", "jobs");
    fs.writeFileSync(path.join(dir, `${JOB_ID}.json`), "{not json");
    const result = spliceCodexResult(JOB_ID, reviewFile, opts());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not valid JSON");
  });

  it("fails when the placeholder is missing or duplicated", () => {
    writeJob({ status: "completed", result: { rawOutput: "review body" } });

    fs.writeFileSync(reviewFile, "# Review\n\nno placeholder here\n");
    let result = spliceCodexResult(JOB_ID, reviewFile, opts());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("placeholder not found");

    fs.writeFileSync(
      reviewFile,
      `${CODEX_REVIEW_PLACEHOLDER}\n${CODEX_REVIEW_PLACEHOLDER}\n`
    );
    result = spliceCodexResult(JOB_ID, reviewFile, opts());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("multiple placeholders");
  });

  it("rejects malformed job ids without touching state", () => {
    for (const bad of ["../escape", "a b", "", ".hidden", "id/with/slash"]) {
      const result = spliceCodexResult(bad, reviewFile, opts());
      expect(result.ok).toBe(false);
      expect(result.message).toContain("invalid job id");
    }
  });

  it("fails when the review file is missing", () => {
    writeJob({ status: "completed", result: { rawOutput: "review body" } });
    const result = spliceCodexResult(
      JOB_ID,
      path.join(tmpDir, "missing.md"),
      opts()
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("review file not found");
  });

  it("fails when no state root exists", () => {
    const result = spliceCodexResult(JOB_ID, reviewFile, {
      stateRoots: [path.join(tmpDir, "nonexistent")],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no codex plugin state");
  });

  it("leaves the review file untouched when the write fails", () => {
    if (process.getuid && process.getuid() === 0) return; // root ignores modes
    writeJob({ status: "completed", result: { rawOutput: "review body" } });
    const original = fs.readFileSync(reviewFile, "utf-8");
    fs.chmodSync(tmpDir, 0o555);
    try {
      const result = spliceCodexResult(JOB_ID, reviewFile, opts());
      expect(result.ok).toBe(false);
      expect(result.message).toContain("write failed");
      expect(fs.readFileSync(reviewFile, "utf-8")).toBe(original);
    } finally {
      fs.chmodSync(tmpDir, 0o755);
    }
  });

  it("binds the splice to the handoff via --expect timestamp", () => {
    writeJob({ status: "completed", result: { rawOutput: "review body" } });
    const stamped =
      `# Review\n\n**Date:** 2026-07-27T10:00:00.000Z\n\n## Codex Review\n\n${CODEX_REVIEW_PLACEHOLDER}\n`;
    fs.writeFileSync(reviewFile, stamped);

    // Wrong timestamp = the review file was regenerated by a later handoff
    // (same sessionName → same path). The old job must not land in it.
    const mismatch = spliceCodexResult(JOB_ID, reviewFile, {
      ...opts(),
      expectTimestamp: "2026-07-27T09:00:00.000Z",
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.message).toContain("does not match this handoff");
    expect(fs.readFileSync(reviewFile, "utf-8")).toBe(stamped);

    // Matching timestamp splices normally.
    const match = spliceCodexResult(JOB_ID, reviewFile, {
      ...opts(),
      expectTimestamp: "2026-07-27T10:00:00.000Z",
    });
    expect(match.ok).toBe(true);
    expect(fs.readFileSync(reviewFile, "utf-8")).toContain("review body");
  });

  it("fails closed on a short write: original file and placeholder intact", () => {
    writeJob({ status: "completed", result: { rawOutput: "a full review body" } });
    const original = fs.readFileSync(reviewFile, "utf-8");

    fsMock.truncateWrites = true;
    const result = spliceCodexResult(JOB_ID, reviewFile, opts());

    expect(result.ok).toBe(false);
    expect(result.message).toContain("review file untouched");
    // The one failure the byte-fidelity check exists to catch must never
    // replace the review file (verification runs BEFORE the rename).
    expect(fs.readFileSync(reviewFile, "utf-8")).toBe(original);
    expect(fs.readFileSync(reviewFile, "utf-8")).toContain(
      CODEX_REVIEW_PLACEHOLDER
    );
    // No stray temp file left behind.
    expect(
      fs.readdirSync(path.dirname(reviewFile)).filter((f) =>
        f.includes("splice-tmp")
      )
    ).toHaveLength(0);
  });

  it("preserves the review file's mode, including umask-filtered bits", () => {
    if (process.getuid && process.getuid() === 0) return; // root ignores modes
    writeJob({ status: "completed", result: { rawOutput: "review body" } });
    fs.chmodSync(reviewFile, 0o664); // group-write: dropped by umask 022 without fchmod

    const result = spliceCodexResult(JOB_ID, reviewFile, opts());

    expect(result.ok).toBe(true);
    expect(fs.statSync(reviewFile).mode & 0o777).toBe(0o664);
  });

  it("preserves exact trailing-newline behavior", () => {
    writeJob({ status: "completed", result: { rawOutput: "no trailing newline" } });
    fs.writeFileSync(reviewFile, `before\n${CODEX_REVIEW_PLACEHOLDER}`);
    const result = spliceCodexResult(JOB_ID, reviewFile, opts());
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(reviewFile, "utf-8")).toBe("before\nno trailing newline");
  });
});
