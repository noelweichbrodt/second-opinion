#!/usr/bin/env node
/**
 * Splice a completed background Codex job's stored final message verbatim
 * over the review-file placeholder — without routing the review body through
 * Claude's context (it otherwise crosses twice: /codex:result, then the Edit
 * that pastes it).
 *
 * The openai-codex plugin persists each tracked job, including the exact
 * final message (`result.rawOutput`), under
 * `<plugin-data>/state/<workspace-slug>/jobs/<job-id>.json`. That location is
 * plugin-internal, not a documented contract, so this helper FEATURE-DETECTS
 * the shape and fails closed on any anomaly: the review file is modified only
 * after every check passes, via an fsynced temp file and atomic rename.
 *
 * Failure modes covered (each leaves reviewFile untouched): job missing,
 * ambiguous, or not completed; rawOutput absent/empty/non-string (shape
 * drift); placeholder missing or duplicated; write/rename failure; post-write
 * verification mismatch.
 *
 * Usage: node splice-codex-result.js <job-id> <reviewFile>
 * Output: "OK spliced <bytes> B sha256=<hash12>" (exit 0) or "FAIL: <reason>" (exit 1)
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";
import { globSync } from "glob";
import { CODEX_REVIEW_PLACEHOLDER } from "../providers/codex.js";

export interface SpliceResult {
  ok: boolean;
  message: string;
}

export interface SpliceOptions {
  /** Override the plugin state roots to search (tests). */
  stateRoots?: string[];
  /**
   * Identity binding: the handoff's ISO timestamp. When set, the review file
   * must carry the matching `**Date:** <timestamp>` metadata line or the
   * splice refuses — without it, a later handoff reusing the same
   * sessionName produces the same reviewFile path, and an older job's output
   * would silently land in the newer document.
   */
  expectTimestamp?: string;
}

function fail(reason: string): SpliceResult {
  return { ok: false, message: `FAIL: ${reason}` };
}

function defaultStateRoots(): string[] {
  const roots: string[] = [];
  if (process.env.CLAUDE_PLUGIN_DATA) {
    roots.push(path.join(process.env.CLAUDE_PLUGIN_DATA, "state"));
  }
  roots.push(
    path.join(
      os.homedir(),
      ".claude",
      "plugins",
      "data",
      "codex-openai-codex",
      "state"
    )
  );
  return roots;
}

export function spliceCodexResult(
  jobId: string,
  reviewFile: string,
  options: SpliceOptions = {}
): SpliceResult {
  // The id becomes a glob path segment — restrict to the plugin's id alphabet.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(jobId)) {
    return fail(`invalid job id: ${jobId}`);
  }

  const roots = (options.stateRoots ?? defaultStateRoots()).filter((r) =>
    fs.existsSync(r)
  );
  if (roots.length === 0) {
    return fail("no codex plugin state directory found (plugin not installed?)");
  }

  const matches = [
    ...new Set(
      roots.flatMap((root) =>
        globSync(`**/jobs/${jobId}.json`, { cwd: root, absolute: true })
      )
    ),
  ];
  if (matches.length === 0) {
    return fail(`job ${jobId} not found in plugin state (pruned or wrong id?)`);
  }
  if (matches.length > 1) {
    return fail(`job ${jobId} is ambiguous: ${matches.length} state entries`);
  }

  let job: unknown;
  try {
    job = JSON.parse(fs.readFileSync(matches[0], "utf-8"));
  } catch {
    return fail(`job state is not valid JSON: ${matches[0]}`);
  }

  // Feature detection: only the shapes we positively recognize are spliced.
  const record = job as { status?: unknown; result?: { rawOutput?: unknown } };
  if (record.status !== "completed") {
    return fail(`job status is ${JSON.stringify(record.status)}, not completed`);
  }
  const rawOutput = record.result?.rawOutput;
  if (typeof rawOutput !== "string" || rawOutput.trim().length === 0) {
    return fail(
      "job has no usable result.rawOutput (plugin state shape may have changed)"
    );
  }

  if (!fs.existsSync(reviewFile)) {
    return fail(`review file not found: ${reviewFile}`);
  }
  const review = fs.readFileSync(reviewFile, "utf-8");
  if (
    options.expectTimestamp &&
    !review.includes(`**Date:** ${options.expectTimestamp}`)
  ) {
    return fail(
      `review file does not match this handoff (expected Date ${options.expectTimestamp}) — ` +
        "it was probably regenerated; use the newest handoff's spliceCommand"
    );
  }
  const parts = review.split(CODEX_REVIEW_PLACEHOLDER);
  if (parts.length === 1) {
    return fail("placeholder not found in review file (already spliced?)");
  }
  if (parts.length > 2) {
    return fail("multiple placeholders in review file — refusing to guess");
  }

  // String concatenation, not String.replace: replace() interprets `$` in
  // the replacement and would corrupt review bodies containing it.
  const spliced = parts[0] + rawOutput + parts[1];

  const tempFile = `${reviewFile}.splice-tmp-${process.pid}`;
  try {
    // Preserve the review file's mode across the rename. fchmodSync, not
    // just the open mode: the open mode is filtered by the umask and would
    // silently drop e.g. group-write bits.
    const mode = fs.statSync(reviewFile).mode & 0o777;
    const fd = fs.openSync(tempFile, "w", mode);
    fs.fchmodSync(fd, mode);
    try {
      fs.writeSync(fd, spliced, null, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    // Byte-fidelity verification BEFORE the rename: a short or corrupted
    // write must never replace the review file — the original and its
    // placeholder stay untouched and the splice can simply be retried.
    const written = fs.readFileSync(tempFile, "utf-8");
    if (written !== spliced) {
      fs.rmSync(tempFile, { force: true });
      return fail(
        "temp-file verification mismatch — review file untouched, retry the splice"
      );
    }

    fs.renameSync(tempFile, reviewFile);
  } catch (error) {
    try {
      fs.rmSync(tempFile, { force: true });
    } catch {
      // best-effort cleanup
    }
    const message = error instanceof Error ? error.message : String(error);
    return fail(`write failed, review file untouched: ${message}`);
  }

  const sha = crypto
    .createHash("sha256")
    .update(rawOutput, "utf-8")
    .digest("hex")
    .slice(0, 12);
  return {
    ok: true,
    message: `OK spliced ${Buffer.byteLength(rawOutput, "utf-8")} B sha256=${sha}`,
  };
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const args = process.argv.slice(2);
  let expectTimestamp: string | undefined;
  const expectIdx = args.indexOf("--expect");
  if (expectIdx !== -1) {
    expectTimestamp = args[expectIdx + 1];
    args.splice(expectIdx, 2);
  }
  const [jobId, reviewFile] = args;
  // --expect is mandatory on the CLI: a hand-composed command without it
  // would skip the identity binding entirely. (The exported function keeps
  // it optional for tests.)
  if (!jobId || !reviewFile || !expectTimestamp) {
    console.error(
      "Usage: splice-codex-result.js <job-id> --expect <iso-timestamp> <reviewFile>"
    );
    process.exit(2);
  }
  const result = spliceCodexResult(jobId, path.resolve(reviewFile), {
    expectTimestamp,
  });
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}
