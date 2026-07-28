import { describe, it, expect } from "vitest";
import { buildReviewPrompt, getSystemPrompt, ReviewRequest } from "./base.js";

describe("getSystemPrompt", () => {
  it("returns task prompt when hasTask is true", () => {
    const prompt = getSystemPrompt(true);
    expect(prompt).toContain("Complete the requested task");
    expect(prompt).not.toContain("code review");
  });

  it("returns review prompt when hasTask is false", () => {
    const prompt = getSystemPrompt(false);
    expect(prompt).toContain("code review");
    expect(prompt).toContain("staff software engineer");
  });

  it("delegates the methodology to the instructions block", () => {
    const prompt = getSystemPrompt(false);
    expect(prompt).toContain("Follow the review methodology in <instructions>");
    // The nucleus must not restate what the methodology already carries; that
    // duplication is what the R1 trim removed. See plans/r1-r3-eval-results.md.
    expect(prompt).not.toContain("Think in phases");
    expect(prompt).not.toContain("upstream or downstream");
    expect(prompt).not.toContain("Pre-existing Issues");
  });

  it("encourages lateral thinking in task prompt", () => {
    const prompt = getSystemPrompt(true);
    expect(prompt).toContain("staff software engineer");
    expect(prompt).toContain("upstream or downstream");
  });

  it("always includes the anti-fabrication rules in review prompt", () => {
    const prompt = getSystemPrompt(false);
    // Verified-only findings, quoted evidence for the loudest severity, a
    // Questions escape hatch for unconfirmed suspicions, and search-before-
    // claiming-absence. These four survive the trim because nothing else
    // states them.
    expect(prompt).toContain("Report only issues you can verify");
    expect(prompt).toContain("Quote the code for [BLOCKING] findings");
    expect(prompt).toContain("list it under Questions");
    expect(prompt).toContain("Search the full provided context");
  });

  it("pins the review nucleus to the evaluated text", () => {
    // This exact string is what the blind quality eval scored as arm B
    // (plans/r1-r3-eval-results.md). Containment assertions alone let the old
    // 767 B verification block be appended back with the suite still green, so
    // the nucleus is pinned by equality: changing it invalidates the eval and
    // must go through a fresh one.
    expect(getSystemPrompt(false)).toBe(
      "You are a staff software engineer performing a code review. "
      + "Follow the review methodology in <instructions>. "
      + "Report only issues you can verify in the provided code. "
      + "Quote the code for [BLOCKING] findings. "
      + "If you suspect an issue but cannot locate confirming code, list it under Questions, "
      + "not as a confirmed finding. "
      + "Search the full provided context before claiming something doesn't exist."
    );
  });

  it("keeps grounding but drops review apparatus in the task prompt", () => {
    const prompt = getSystemPrompt(true);
    expect(prompt).toContain("Complete the requested task");
    // Replacement tasks keep the no-fabrication rule…
    expect(prompt).toContain("Ground every claim");
    // …but not the review nucleus: no methodology delegation, no severity
    // vocabulary, no Questions routing.
    expect(prompt).not.toContain("<instructions>");
    expect(prompt).not.toContain("[BLOCKING]");
    expect(prompt).not.toContain("Questions");
  });
});

describe("buildReviewPrompt", () => {
  it("builds prompt with task as primary objective", () => {
    const request: ReviewRequest = {
      instructions: "Review guidelines here",
      context: "# Code\n```ts\nconst x = 1;\n```",
      task: "Analyze security vulnerabilities",
    };

    const prompt = buildReviewPrompt(request);

    expect(prompt).toContain("<task>");
    expect(prompt).toContain("Analyze security vulnerabilities");
    expect(prompt).toContain("<reference-instructions>");
    expect(prompt).toContain("<code-context>");
    expect(prompt).toContain("const x = 1;");
  });

  it("builds prompt in review mode when no task", () => {
    const request: ReviewRequest = {
      instructions: "Review guidelines here",
      context: "# Code\n```ts\nconst x = 1;\n```",
    };

    const prompt = buildReviewPrompt(request);

    expect(prompt).not.toContain("<task>");
    expect(prompt).toContain("Review guidelines here");
    expect(prompt).toContain("<code-context>");
  });

  it("includes focus areas when provided", () => {
    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
      focusAreas: ["Security", "Performance"],
    };

    const prompt = buildReviewPrompt(request);

    expect(prompt).toContain("Focus Areas");
    expect(prompt).toContain("- Security");
    expect(prompt).toContain("- Performance");
  });

  it("includes focus areas in task mode", () => {
    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
      task: "Analyze code",
      focusAreas: ["Security"],
    };

    const prompt = buildReviewPrompt(request);

    expect(prompt).toContain("## Focus Areas");
    expect(prompt).toContain("- Security");
  });

  it("includes custom prompt as additional instructions", () => {
    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
      customPrompt: "Pay special attention to error handling",
    };

    const prompt = buildReviewPrompt(request);

    expect(prompt).toContain("## Additional Instructions");
    expect(prompt).toContain("Pay special attention to error handling");
  });

  it("includes custom prompt in task mode", () => {
    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
      task: "Review",
      customPrompt: "Be concise",
    };

    const prompt = buildReviewPrompt(request);

    expect(prompt).toContain("## Additional Instructions");
    expect(prompt).toContain("Be concise");
  });

  it("wraps sections with XML tags", () => {
    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code content here",
    };

    const prompt = buildReviewPrompt(request);

    expect(prompt).toContain("<instructions>");
    expect(prompt).toContain("</instructions>");
    expect(prompt).toContain("<code-context>");
    expect(prompt).toContain("</code-context>");
  });

  it("includes language hints when provided", () => {
    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
      languageHints: "## TypeScript-Specific Pitfalls\n\n- Watch for `any` abuse",
    };

    const prompt = buildReviewPrompt(request);

    expect(prompt).toContain("TypeScript-Specific Pitfalls");
    expect(prompt).toContain("Watch for `any` abuse");
    // Hints should appear after Code Context (content first, instructions second)
    const hintsIndex = prompt.indexOf("TypeScript-Specific");
    const contextIndex = prompt.indexOf("<code-context>");
    expect(hintsIndex).toBeGreaterThan(contextIndex);
  });

  it("includes language hints in task mode", () => {
    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
      task: "Review",
      languageHints: "## Go-Specific Pitfalls\n\n- Check for unchecked errors",
    };

    const prompt = buildReviewPrompt(request);

    expect(prompt).toContain("Go-Specific Pitfalls");
    // Hints should appear after Code Context (content first, instructions second)
    const hintsIndex = prompt.indexOf("Go-Specific");
    const contextIndex = prompt.indexOf("<code-context>");
    expect(hintsIndex).toBeGreaterThan(contextIndex);
  });

  it("omits language hints section when not provided", () => {
    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code",
    };

    const prompt = buildReviewPrompt(request);

    expect(prompt).not.toContain("Specific Pitfalls");
  });
});
