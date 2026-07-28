import { describe, expect, it } from "vitest";
import {
  composeCodexPrompt,
  createCodexRescueCommand,
} from "./codex.js";

describe("composeCodexPrompt", () => {
  it("builds a self-contained, read-only external-review prompt", () => {
    const prompt = composeCodexPrompt({
      instructions: "Use the project review methodology.",
      context: "src/example.ts\n```ts\nconst value = 1;\n```",
      focusAreas: ["Error handling"],
      languageHints: "Check TypeScript narrowing.",
    });

    expect(prompt).toMatch(/^# Codex External Review Handoff/);
    // The header keeps its own role and grounding lines: the R3 trim that would
    // remove them is not shipped, because only R1 landed unconditionally.
    expect(prompt).toContain("acting as an external reviewer");
    expect(prompt).toContain("Ground every finding in the provided");
    // The system prompt spliced below the header carries the R1 nucleus.
    expect(prompt).toContain("staff software engineer performing a code review");
    expect(prompt).toContain("Report only issues you can verify");
    expect(prompt).toContain("<code-context>");
    expect(prompt).toContain("const value = 1;");
    expect(prompt).toContain("Use the project review methodology.");
    expect(prompt).toContain("- Error handling");
    expect(prompt).toContain("Check TypeScript narrowing.");
    expect(prompt).toContain("Do not modify any files");
    expect(prompt).toContain(
      "Produce the complete review markdown as your final message"
    );
    expect(prompt).toContain("Search the full provided context");
  });

  it("preserves base prompt ordering and task-mode instructions", () => {
    const prompt = composeCodexPrompt({
      instructions: "Reference methodology",
      context: "UNIQUE_CODE_CONTEXT",
      branchDiff: "UNIQUE_BRANCH_DIFF",
      task: "UNIQUE_TASK",
      customPrompt: "UNIQUE_ADDITIONAL_INSTRUCTIONS",
    });

    const contextIndex = prompt.indexOf("UNIQUE_CODE_CONTEXT");
    const diffIndex = prompt.indexOf("UNIQUE_BRANCH_DIFF");
    const taskIndex = prompt.indexOf("UNIQUE_TASK");
    const referenceIndex = prompt.indexOf("Reference methodology");

    expect(contextIndex).toBeGreaterThan(0);
    expect(diffIndex).toBeGreaterThan(contextIndex);
    expect(taskIndex).toBeGreaterThan(diffIndex);
    expect(referenceIndex).toBeGreaterThan(taskIndex);
    expect(prompt).toContain("Complete the requested task");
    expect(prompt).toContain("UNIQUE_ADDITIONAL_INSTRUCTIONS");
  });
});

describe("createCodexRescueCommand", () => {
  it("uses the configured model and absolute prompt path without an effort flag", () => {
    const command = createCodexRescueCommand(
      "/absolute/project/second-opinions/example.codex.prompt.md",
      "custom-codex-model"
    );

    expect(command).toContain(
      "/codex:rescue --model custom-codex-model --fresh"
    );
    expect(command).toContain(
      "/absolute/project/second-opinions/example.codex.prompt.md"
    );
    expect(command).toContain("final message");
    expect(command).toContain("modify no files");
    expect(command).not.toContain("--effort");
  });

  it("emits no shell metacharacters that an LLM-authored bash call could expand", () => {
    const command = createCodexRescueCommand(
      "/absolute/project/second-opinions/example.codex.prompt.md",
      "custom-codex-model"
    );

    expect(command).not.toContain("`");
    expect(command).not.toContain('"');
    expect(command).not.toContain("$");
  });
});
