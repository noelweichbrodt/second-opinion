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
    expect(prompt).toContain("constructive");
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

    expect(prompt).toContain("# Task");
    expect(prompt).toContain("Analyze security vulnerabilities");
    expect(prompt).toContain("## Reference Instructions");
    expect(prompt).toContain("# Code Context");
    expect(prompt).toContain("const x = 1;");
  });

  it("builds prompt in review mode when no task", () => {
    const request: ReviewRequest = {
      instructions: "Review guidelines here",
      context: "# Code\n```ts\nconst x = 1;\n```",
    };

    const prompt = buildReviewPrompt(request);

    expect(prompt).not.toContain("# Task");
    expect(prompt).toContain("Review guidelines here");
    expect(prompt).toContain("# Code Context");
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

  it("separates sections with markdown separators", () => {
    const request: ReviewRequest = {
      instructions: "Guidelines",
      context: "Code content here",
    };

    const prompt = buildReviewPrompt(request);

    expect(prompt).toContain("---");
    expect(prompt).toContain("# Code Context");
  });
});
