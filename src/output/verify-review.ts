#!/usr/bin/env node
/**
 * Structural completion check for handoff review files.
 *
 * Replaces the skill's former "read the whole completed file" step: Claude
 * runs this instead and gets a ≤200 B verdict, so a ~13 KB review never
 * re-enters its context just to confirm completeness. Fail-closed: any
 * structural anomaly is a FAIL with a reason.
 *
 * Section boundaries use only the exact headings the formatter emits — a
 * reviewer body may legitimately contain its own `## ...` headings — and
 * emptiness is judged after subtracting the formatter's own boilerplate
 * (model lines, handoff-command block, synthesis instructions). The
 * "lockstep" test builds documents with the real formatter so drift between
 * formatter and verifier fails CI.
 *
 * Usage: node verify-review.js <reviewFile>
 * Output: "OK <bytes> B sha256=<hash12>" (exit 0) or "FAIL: <reason>" (exit 1)
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";
import { CODEX_REVIEW_PLACEHOLDER } from "../providers/codex.js";
import {
  SYNTHESIS_PLACEHOLDER,
  SYNTHESIS_INSTRUCTIONS,
} from "./consensus-formatter.js";
import { REVIEW_FOOTER } from "./writer.js";

export interface VerifyResult {
  ok: boolean;
  message: string;
}

/** Minimum stripped-body size for a section to count as a real review. */
const MIN_SECTION_CHARS = 200;

/** The exact section headings the formatter emits, in document order. */
const CONSENSUS_HEADINGS = [
  "## Synthesis",
  "## Gemini's Review",
  "## Codex Review",
] as const;

function fail(reason: string): VerifyResult {
  return { ok: false, message: `FAIL: ${reason}` };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function headingPattern(heading: string, flags: string): RegExp {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\s*$`, flags);
}

/**
 * Replace the contents of fenced code blocks with same-length filler so
 * heading matches inside a reviewer's quoted markdown (```md ... ```) never
 * count as structure, while every index still maps onto the original text.
 * Fences toggle line-by-line (CommonMark: a fence delimiter starts its own
 * line), so a stray mid-line ``` in prose cannot mis-pair later blocks. An
 * unclosed fence masks through to EOF — a heading inside it then goes
 * unseen, which fails closed via the exactly-once check.
 */
function maskFencedCode(content: string): string {
  const lines = content.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("```")) {
      lines[i] = lines[i].replace(/./g, "~");
      inFence = !inFence;
    } else if (inFence) {
      lines[i] = lines[i].replace(/./g, "~");
    }
  }
  return lines.join("\n");
}

/**
 * Body of `heading`, bounded by the NEXT known formatter heading (not any
 * `## ` line — reviewer output owns those) or end of file. Boundaries are
 * located on the fence-masked text; the returned body is original text.
 */
function sectionBody(
  content: string,
  masked: string,
  heading: string
): string {
  const match = headingPattern(heading, "m").exec(masked);
  if (!match) return "";
  const start = match.index + match[0].length;
  const maskedRest = masked.slice(start);

  let end = maskedRest.length;
  for (const other of CONSENSUS_HEADINGS) {
    if (other === heading) continue;
    const next = headingPattern(other, "m").exec(maskedRest);
    if (next && next.index < end) end = next.index;
  }
  return content.slice(start, start + end);
}

/**
 * Remove formatter-owned boilerplate so the length check measures reviewer
 * content only. Every pattern corresponds to output of consensus-formatter.ts
 * or the codex-only placeholder body in tools/review.ts; the lockstep test
 * pins them to the real generators.
 */
function stripFormatterBoilerplate(body: string): string {
  return body
    .split(SYNTHESIS_INSTRUCTIONS)
    .join("")
    .split(REVIEW_FOOTER)
    .join("")
    .replace(/^\*Model: .*\*$/gm, "")
    .replace(/^\*Tokens: .*\*$/gm, "")
    .replace(/^Run the (?:Codex )?handoff command(?: below)?, then replace the placeholder.*$/gm, "")
    .replace(/^```text\n\/codex:rescue[\s\S]*?\n```$/gm, "")
    .replace(/^Prompt file: `.*`$/gm, "")
    .replace(/^---$/gm, "")
    .trim();
}

function checkSection(
  content: string,
  masked: string,
  heading: string
): VerifyResult | null {
  const count = (masked.match(headingPattern(heading, "gm")) || []).length;
  if (count !== 1) {
    return fail(`expected exactly one "${heading}" section, found ${count}`);
  }
  const stripped = stripFormatterBoilerplate(
    sectionBody(content, masked, heading)
  );
  if (stripped.length < MIN_SECTION_CHARS) {
    return fail(`"${heading}" section is empty or too short`);
  }
  return null;
}

export function verifyReviewFile(filePath: string): VerifyResult {
  if (!fs.existsSync(filePath)) {
    return fail(`file not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const name = path.basename(filePath);

  if (countOccurrences(content, CODEX_REVIEW_PLACEHOLDER) > 0) {
    return fail("Codex placeholder still present — handoff incomplete");
  }

  const masked = maskFencedCode(content);

  if (name.includes(".consensus.")) {
    if (countOccurrences(content, SYNTHESIS_PLACEHOLDER) > 0) {
      return fail("Synthesis placeholder still present");
    }
    for (const heading of CONSENSUS_HEADINGS) {
      const problem = checkSection(content, masked, heading);
      if (problem) return problem;
    }
  } else if (name.includes(".codex.")) {
    const problem = checkSection(content, masked, "## Codex Review");
    if (problem) return problem;
  }

  const sha = crypto
    .createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, 12);
  return {
    ok: true,
    message: `OK ${Buffer.byteLength(content, "utf-8")} B sha256=${sha}`,
  };
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: verify-review.js <reviewFile>");
    process.exit(2);
  }
  const result = verifyReviewFile(path.resolve(file));
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}
