import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { verifyReviewFile } from "./verify-review.js";
import { CODEX_REVIEW_PLACEHOLDER } from "../providers/codex.js";
import {
  SYNTHESIS_PLACEHOLDER,
  SYNTHESIS_INSTRUCTIONS,
  formatConsensusOutput,
} from "./consensus-formatter.js";
import { REVIEW_FOOTER } from "./writer.js";
import { createTempDir, cleanupTempDir } from "../test-utils.js";

const LONG_BODY = "Detailed findings with evidence and reasoning. ".repeat(10);

// Real reviews open with their own headings (e.g. "## Summary") — section
// bounds must use the formatter's known headings, not any "## " line.
const HEADING_RICH_BODY = [
  "## Summary",
  "",
  LONG_BODY,
  "",
  "## Critical Issues",
  "",
  LONG_BODY,
].join("\n");

function consensusDoc(overrides: {
  synthesis?: string;
  gemini?: string;
  codex?: string;
  extraHeading?: string;
} = {}): string {
  return [
    "# Consensus Code Review",
    "",
    "## Synthesis",
    "",
    overrides.synthesis ?? LONG_BODY,
    "",
    "---",
    "",
    "## Gemini's Review",
    "",
    overrides.gemini ?? LONG_BODY,
    "",
    "---",
    "",
    overrides.extraHeading ?? "",
    "## Codex Review",
    "",
    overrides.codex ?? LONG_BODY,
    "",
  ].join("\n");
}

describe("verifyReviewFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir("verify");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  function write(name: string, content: string): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("passes a complete consensus review with a compact verdict", () => {
    const file = write("session.consensus.review.md", consensusDoc());
    const result = verifyReviewFile(file);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^OK \d+ B sha256=[0-9a-f]{12}$/);
    expect(result.message.length).toBeLessThanOrEqual(200);
  });

  it("fails when the Codex placeholder is still present", () => {
    const file = write(
      "session.consensus.review.md",
      consensusDoc({ codex: CODEX_REVIEW_PLACEHOLDER })
    );
    const result = verifyReviewFile(file);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("placeholder still present");
  });

  it("fails when the synthesis placeholder is still present", () => {
    const file = write(
      "session.consensus.review.md",
      consensusDoc({ synthesis: SYNTHESIS_PLACEHOLDER })
    );
    const result = verifyReviewFile(file);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Synthesis placeholder");
  });

  it("fails on duplicate required sections", () => {
    const file = write(
      "session.consensus.review.md",
      consensusDoc({ extraHeading: "## Codex Review\n\nstray\n" })
    );
    const result = verifyReviewFile(file);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('"## Codex Review"');
    expect(result.message).toContain("found 2");
  });

  it("fails on an empty review body", () => {
    const file = write(
      "session.consensus.review.md",
      consensusDoc({ gemini: "short" })
    );
    const result = verifyReviewFile(file);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Gemini's Review");
  });

  it("verifies codex-only reviews", () => {
    const complete = write(
      "session.codex.review.md",
      `# Code Review - session\n\n## Codex Review\n\n${LONG_BODY}\n`
    );
    expect(verifyReviewFile(complete).ok).toBe(true);

    const pending = write(
      "pending.codex.review.md",
      `# Code Review - session\n\n## Codex Review\n\n${CODEX_REVIEW_PLACEHOLDER}\n`
    );
    const result = verifyReviewFile(pending);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("placeholder");
  });

  it("fails on a missing file", () => {
    const result = verifyReviewFile(path.join(tmpDir, "nope.consensus.review.md"));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("passes plain gemini reviews with no handoff structure", () => {
    const file = write("session.gemini.review.md", `# Review\n\n${LONG_BODY}`);
    expect(verifyReviewFile(file).ok).toBe(true);
  });

  function realFormatted(): string {
    return formatConsensusOutput({
      gemini: {
        // Heading-rich, like real reviewer output.
        review: HEADING_RICH_BODY,
        model: "gemini-pro-latest",
        tokensUsed: 500,
      },
      codex: {
        promptFile: "/p/x.prompt.md",
        reviewFile: "/p/x.md",
        egressManifestFile: "/p/x.egress.json",
        rescueCommand: "/codex:rescue --model m --fresh task",
        verifyCommand: "node 'verify-review.js' '/p/x.md'",
        spliceCommand: "node 'splice-codex-result.js' JOB_ID '/p/x.md'",
        model: "m",
      },
    });
  }

  it("stays in lockstep with the real consensus formatter", () => {
    // Guard against formatter/verifier drift: the document the formatter
    // emits must fail while pending and pass once both placeholders are
    // replaced, exactly as the skill flow produces it — including reviewer
    // bodies that open with their own `##` headings.
    const formatted = realFormatted();

    const pending = write("pending.consensus.review.md", formatted);
    expect(verifyReviewFile(pending).ok).toBe(false);

    const completed = formatted
      .replace(CODEX_REVIEW_PLACEHOLDER, HEADING_RICH_BODY)
      .replace(SYNTHESIS_PLACEHOLDER + "\n\n" + SYNTHESIS_INSTRUCTIONS, LONG_BODY);
    const done = write("done.consensus.review.md", completed);
    const result = verifyReviewFile(done);
    expect(result.ok).toBe(true);
  });

  it("ignores formatter headings quoted inside fenced code blocks", () => {
    // A reviewer discussing this repo may quote the layout itself; a fenced
    // "## Codex Review" is content, not structure.
    const bodyQuotingLayout =
      HEADING_RICH_BODY +
      "\n\n```md\n## Codex Review\n## Synthesis\n```\n";
    const formatted = realFormatted();
    const completed = formatted
      .replace(CODEX_REVIEW_PLACEHOLDER, bodyQuotingLayout)
      .replace(SYNTHESIS_PLACEHOLDER + "\n\n" + SYNTHESIS_INSTRUCTIONS, LONG_BODY);
    const file = write("fenced.consensus.review.md", completed);

    const result = verifyReviewFile(file);
    expect(result.ok).toBe(true);
  });

  it("is not derailed by stray mid-line backtick runs in prose", () => {
    // A global ``` regex would pair a stray mid-line run in one section with
    // a real fence opener in the next, masking the real heading between them.
    const geminiBody =
      HEADING_RICH_BODY +
      "\n\nAuthors sometimes write ``` to open a block.\n";
    const codexBody =
      HEADING_RICH_BODY + "\n\n```ts\nconst x = 1;\n```\n";
    const formatted = formatConsensusOutput({
      gemini: { review: geminiBody, model: "gemini-pro-latest" },
      codex: {
        promptFile: "/p/x.prompt.md",
        reviewFile: "/p/x.md",
        egressManifestFile: "/p/x.egress.json",
        rescueCommand: "/codex:rescue --model m --fresh task",
        verifyCommand: "node 'verify-review.js' '/p/x.md'",
        spliceCommand: "node 'splice-codex-result.js' JOB_ID --expect 't' '/p/x.md'",
        model: "m",
      },
    });
    const completed = formatted
      .replace(CODEX_REVIEW_PLACEHOLDER, codexBody)
      .replace(SYNTHESIS_PLACEHOLDER + "\n\n" + SYNTHESIS_INSTRUCTIONS, LONG_BODY);
    const file = write("stray-backtick.consensus.review.md", completed);

    expect(verifyReviewFile(file).ok).toBe(true);
  });

  it("strips the shared footer from body measurements", () => {
    // REVIEW_FOOTER is shared with writer.ts; padding a body with footers
    // must not satisfy the length floor.
    const padded = Array(10).fill(REVIEW_FOOTER).join("\n");
    const file = write(
      "footer-padded.codex.review.md",
      `# Review\n\n**Date:** t\n\n## Codex Review\n\n${padded}\n`
    );
    const result = verifyReviewFile(file);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("empty or too short");
  });

  it("rejects near-empty reviews despite formatter boilerplate padding", () => {
    // The Codex section keeps ~300 B of handoff instructions and the
    // Synthesis section its instruction block; neither may count as review
    // content ("false PASS" regression).
    const formatted = realFormatted();

    const emptyCodex = formatted
      .replace(CODEX_REVIEW_PLACEHOLDER, "ok.")
      .replace(SYNTHESIS_PLACEHOLDER + "\n\n" + SYNTHESIS_INSTRUCTIONS, LONG_BODY);
    const codexFile = write("empty-codex.consensus.review.md", emptyCodex);
    const codexResult = verifyReviewFile(codexFile);
    expect(codexResult.ok).toBe(false);
    expect(codexResult.message).toContain("Codex Review");

    // Synthesis placeholder replaced with 2 chars, instruction block left
    // behind (instructions alone must not satisfy the length check).
    const emptySynthesis = formatted
      .replace(CODEX_REVIEW_PLACEHOLDER, HEADING_RICH_BODY)
      .replace(SYNTHESIS_PLACEHOLDER, "ok");
    const synthFile = write("empty-synth.consensus.review.md", emptySynthesis);
    const synthResult = verifyReviewFile(synthFile);
    expect(synthResult.ok).toBe(false);
    expect(synthResult.message).toContain("Synthesis");
  });
});
