import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  findLatestSession,
  getSessionPath,
  parseSession,
  formatConversationContext,
} from "./session.js";
import {
  createTempDir,
  cleanupTempDir,
  createProjectStructure,
  createMockSession,
  createMockToolResult,
  createMockSessionIndex,
} from "../test-utils.js";

// Mock getClaudeProjectsDir to use our temp directory
const mockProjectsDir = createTempDir("claude-projects");

vi.mock("../config.js", () => ({
  getClaudeProjectsDir: () => mockProjectsDir,
}));

describe("findLatestSession", () => {
  let projectDir: string;
  let projectPath: string;

  beforeAll(() => {
    // Create a mock Claude projects structure
    projectPath = "/Users/test/myproject";
    projectDir = path.join(mockProjectsDir, "-Users-test-myproject");
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterAll(() => {
    cleanupTempDir(projectDir);
  });

  it("finds session by originalPath in index", () => {
    const sessionId = "test-session-1";

    // Create index with originalPath
    createMockSessionIndex(projectDir, [
      {
        sessionId,
        modified: new Date().toISOString(),
      },
    ], projectPath);

    // Create the session file
    fs.writeFileSync(
      path.join(projectDir, `${sessionId}.jsonl`),
      createMockSession([{ type: "user", content: "Hello" }])
    );

    const result = findLatestSession(projectPath);
    expect(result).toBe(sessionId);
  });

  it("returns most recent session when multiple exist", () => {
    const oldSession = "old-session";
    const newSession = "new-session";

    // Create index with multiple sessions
    createMockSessionIndex(projectDir, [
      {
        sessionId: oldSession,
        modified: new Date(Date.now() - 10000).toISOString(),
      },
      {
        sessionId: newSession,
        modified: new Date().toISOString(),
      },
    ], projectPath);

    const result = findLatestSession(projectPath);
    expect(result).toBe(newSession);
  });

  it("returns null for non-existent project", () => {
    const result = findLatestSession("/nonexistent/project");
    expect(result).toBeNull();
  });

  it("returns null when index has empty entries", () => {
    const emptyDir = path.join(mockProjectsDir, "-Users-test-emptyproject");
    fs.mkdirSync(emptyDir, { recursive: true });

    createMockSessionIndex(emptyDir, [], "/Users/test/emptyproject");

    const result = findLatestSession("/Users/test/emptyproject");
    expect(result).toBeNull();

    cleanupTempDir(emptyDir);
  });

  it("finds session via projectPath field in entries", () => {
    // Create a differently-named directory to avoid direct path match
    const altDir = path.join(mockProjectsDir, "-different-path-name");
    fs.mkdirSync(altDir, { recursive: true });
    const altProjectPath = "/Users/other/altproject";

    // Create index with projectPath in entries (not originalPath)
    const indexContent = {
      entries: [{
        sessionId: "alt-session",
        fullPath: path.join(altDir, "alt-session.jsonl"),
        firstPrompt: "Test",
        projectPath: altProjectPath,
        modified: new Date().toISOString(),
      }],
      // No originalPath, forcing fallback to entries check
    };
    fs.writeFileSync(
      path.join(altDir, "sessions-index.json"),
      JSON.stringify(indexContent)
    );
    fs.writeFileSync(
      path.join(altDir, "alt-session.jsonl"),
      createMockSession([{ type: "user", content: "Test" }])
    );

    const result = findLatestSession(altProjectPath);
    expect(result).toBe("alt-session");

    cleanupTempDir(altDir);
  });

  it("handles malformed index JSON gracefully", () => {
    const malformedDir = path.join(mockProjectsDir, "-Users-test-malformed");
    fs.mkdirSync(malformedDir, { recursive: true });

    // Write malformed JSON to index
    fs.writeFileSync(
      path.join(malformedDir, "sessions-index.json"),
      "{ not valid json"
    );

    // Should return null and not throw
    const result = findLatestSession("/Users/test/malformed");
    expect(result).toBeNull();

    cleanupTempDir(malformedDir);
  });
});

describe("getSessionPath", () => {
  let projectDir: string;
  let projectPath: string;

  beforeAll(() => {
    projectPath = "/Users/test/sessionpath";
    projectDir = path.join(mockProjectsDir, "-Users-test-sessionpath");
    fs.mkdirSync(projectDir, { recursive: true });

    createMockSessionIndex(projectDir, [
      { sessionId: "existing-session" },
    ], projectPath);

    fs.writeFileSync(
      path.join(projectDir, "existing-session.jsonl"),
      createMockSession([{ type: "user", content: "Test" }])
    );
  });

  afterAll(() => {
    cleanupTempDir(projectDir);
  });

  it("returns path for existing session", () => {
    const result = getSessionPath(projectPath, "existing-session");
    expect(result).toBe(path.join(projectDir, "existing-session.jsonl"));
  });

  it("returns null for non-existent session", () => {
    const result = getSessionPath(projectPath, "nonexistent-session");
    expect(result).toBeNull();
  });

  it("returns null for non-existent project", () => {
    const result = getSessionPath("/nonexistent", "some-session");
    expect(result).toBeNull();
  });
});

describe("parseSession", () => {
  let projectDir: string;
  let projectPath: string;

  beforeAll(() => {
    projectPath = "/Users/test/parseproject";
    projectDir = path.join(mockProjectsDir, "-Users-test-parseproject");
    fs.mkdirSync(projectDir, { recursive: true });

    createMockSessionIndex(projectDir, [
      { sessionId: "parse-test" },
    ], projectPath);
  });

  afterAll(() => {
    cleanupTempDir(projectDir);
  });

  it("extracts user messages", () => {
    const sessionContent = createMockSession([
      { type: "user", content: "Help me with this code" },
      { type: "assistant", content: "I can help you." },
      { type: "user", content: "Thanks!" },
    ]);

    fs.writeFileSync(
      path.join(projectDir, "parse-test.jsonl"),
      sessionContent
    );

    const result = parseSession(projectPath, "parse-test");

    expect(result).not.toBeNull();
    expect(result!.conversation.filter((m) => m.role === "user")).toHaveLength(2);
    expect(result!.conversation[0].content).toBe("Help me with this code");
    expect(result!.conversation[2].content).toBe("Thanks!");
  });

  it("extracts assistant messages", () => {
    const sessionContent = createMockSession([
      { type: "user", content: "Hello" },
      { type: "assistant", content: "Hi! How can I help?" },
    ]);

    fs.writeFileSync(
      path.join(projectDir, "parse-test.jsonl"),
      sessionContent
    );

    const result = parseSession(projectPath, "parse-test");

    expect(result!.conversation.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(result!.conversation[1].content).toBe("Hi! How can I help?");
  });

  it("tracks file read operations", () => {
    const sessionContent = createMockSession([
      { type: "user", content: "Read the config" },
      {
        type: "assistant",
        content: "I'll read it.",
        toolUses: [
          {
            id: "read-1",
            name: "Read",
            input: { file_path: "/project/config.ts" },
          },
        ],
      },
    ]);

    fs.writeFileSync(
      path.join(projectDir, "parse-test.jsonl"),
      sessionContent
    );

    const result = parseSession(projectPath, "parse-test");

    expect(result!.filesRead).toContain("/project/config.ts");
  });

  it("tracks file write operations", () => {
    const sessionContent = createMockSession([
      { type: "user", content: "Create a file" },
      {
        type: "assistant",
        content: "Creating...",
        toolUses: [
          {
            id: "write-1",
            name: "Write",
            input: {
              file_path: "/project/new.ts",
              content: "export const x = 1;",
            },
          },
        ],
      },
    ]);

    fs.writeFileSync(
      path.join(projectDir, "parse-test.jsonl"),
      sessionContent
    );

    const result = parseSession(projectPath, "parse-test");

    expect(result!.filesWritten).toContain("/project/new.ts");
    expect(result!.fileContents.get("/project/new.ts")).toBe("export const x = 1;");
  });

  it("tracks file edit operations", () => {
    const sessionContent = createMockSession([
      { type: "user", content: "Edit the file" },
      {
        type: "assistant",
        content: "Editing...",
        toolUses: [
          {
            id: "edit-1",
            name: "Edit",
            input: {
              file_path: "/project/existing.ts",
              old_string: "old",
              new_string: "new",
            },
          },
        ],
      },
    ]);

    fs.writeFileSync(
      path.join(projectDir, "parse-test.jsonl"),
      sessionContent
    );

    const result = parseSession(projectPath, "parse-test");

    expect(result!.filesEdited).toContain("/project/existing.ts");
  });

  it("skips system/meta messages", () => {
    // Create a session with local-command messages (should be skipped)
    const lines = [
      JSON.stringify({
        type: "user",
        message: { content: "<local-command>clear</local-command>" },
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: "user",
        message: { content: "Real user message" },
        timestamp: new Date().toISOString(),
      }),
    ];

    fs.writeFileSync(
      path.join(projectDir, "parse-test.jsonl"),
      lines.join("\n")
    );

    const result = parseSession(projectPath, "parse-test");

    expect(result!.conversation).toHaveLength(1);
    expect(result!.conversation[0].content).toBe("Real user message");
  });

  it("handles malformed JSONL lines gracefully", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        message: { content: "Valid message" },
        timestamp: new Date().toISOString(),
      }),
      "not valid json",
      "{incomplete json",
      JSON.stringify({
        type: "user",
        message: { content: "Another valid message" },
        timestamp: new Date().toISOString(),
      }),
    ];

    fs.writeFileSync(
      path.join(projectDir, "parse-test.jsonl"),
      lines.join("\n")
    );

    // Should not throw, should skip bad lines
    const result = parseSession(projectPath, "parse-test");

    expect(result).not.toBeNull();
    expect(result!.conversation).toHaveLength(2);
  });

  it("returns null for non-existent session", () => {
    const result = parseSession(projectPath, "nonexistent");
    expect(result).toBeNull();
  });

  it("skips API error messages", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "API Error: rate limit exceeded" }],
        },
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Real response" }],
        },
        timestamp: new Date().toISOString(),
      }),
    ];

    fs.writeFileSync(
      path.join(projectDir, "parse-test.jsonl"),
      lines.join("\n")
    );

    const result = parseSession(projectPath, "parse-test");

    expect(result!.conversation).toHaveLength(1);
    expect(result!.conversation[0].content).toBe("Real response");
  });

  it("handles tool_result entries for file reads", () => {
    // Create session with tool use and corresponding tool result
    const toolUseId = "read-123";
    const lines = [
      JSON.stringify({
        type: "user",
        message: { content: "Read the config file" },
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "I'll read the file." },
            {
              type: "tool_use",
              id: toolUseId,
              name: "Read",
              input: { file_path: "/project/config.ts" },
            },
          ],
        },
        timestamp: new Date().toISOString(),
      }),
      // Top-level tool_result format
      JSON.stringify({
        type: "tool_result",
        tool_use_id: toolUseId,
        content: "export const config = { port: 3000 };",
      }),
    ];

    fs.writeFileSync(
      path.join(projectDir, "parse-test.jsonl"),
      lines.join("\n")
    );

    const result = parseSession(projectPath, "parse-test");

    expect(result).not.toBeNull();
    expect(result!.filesRead).toContain("/project/config.ts");
    expect(result!.fileContents.get("/project/config.ts")).toBe(
      "export const config = { port: 3000 };"
    );
  });
});

describe("formatConversationContext", () => {
  it("formats conversation as markdown", () => {
    const context = {
      sessionId: "test",
      projectPath: "/project",
      filesRead: [],
      filesWritten: [],
      filesEdited: [],
      fileContents: new Map(),
      conversation: [
        { role: "user" as const, content: "Help me", timestamp: "" },
        { role: "assistant" as const, content: "Sure!", timestamp: "" },
      ],
    };

    const result = formatConversationContext(context);

    expect(result).toContain("## Conversation Context");
    expect(result).toContain("**User**:");
    expect(result).toContain("Help me");
    expect(result).toContain("**Claude**:");
    expect(result).toContain("Sure!");
  });

  it("returns empty string for empty conversation", () => {
    const context = {
      sessionId: "test",
      projectPath: "/project",
      filesRead: [],
      filesWritten: [],
      filesEdited: [],
      fileContents: new Map(),
      conversation: [],
    };

    const result = formatConversationContext(context);

    expect(result).toBe("");
  });

  it("condenses large code blocks", () => {
    // Create a message with mostly code (>50% code and >500 chars)
    const codeBlock = "```typescript\n" + "const x = 1;\n".repeat(100) + "```";

    const context = {
      sessionId: "test",
      projectPath: "/project",
      filesRead: [],
      filesWritten: [],
      filesEdited: [],
      fileContents: new Map(),
      conversation: [
        { role: "assistant" as const, content: codeBlock, timestamp: "" },
      ],
    };

    const result = formatConversationContext(context);

    expect(result).toContain("[code snippet omitted - see Files section for current code]");
  });

  it("truncates very long messages", () => {
    const longContent = "x".repeat(3000);

    const context = {
      sessionId: "test",
      projectPath: "/project",
      filesRead: [],
      filesWritten: [],
      filesEdited: [],
      fileContents: new Map(),
      conversation: [
        { role: "user" as const, content: longContent, timestamp: "" },
      ],
    };

    const result = formatConversationContext(context);

    expect(result).toContain("...(truncated)");
    expect(result.length).toBeLessThan(longContent.length);
  });

  it("truncates long code blocks in smaller messages", () => {
    // A small amount of text with a long code block (>500 chars)
    const longCode = "x".repeat(600);
    const content = `Here's the code:\n\`\`\`typescript\n${longCode}\n\`\`\``;

    const context = {
      sessionId: "test",
      projectPath: "/project",
      filesRead: [],
      filesWritten: [],
      filesEdited: [],
      fileContents: new Map(),
      conversation: [
        { role: "assistant" as const, content, timestamp: "" },
      ],
    };

    const result = formatConversationContext(context);

    // The code block gets replaced with code snippet omitted when >50% is code
    // or truncated when block >500 chars but message is not mostly code
    expect(result).toMatch(/\[.*truncated|omitted.*\]/);
  });

  it("truncates long code blocks while preserving preview", () => {
    // Message where code is <50% but individual block >500 chars
    // Keep message under 2000 chars to avoid message-level truncation
    const textPadding = "Description. ".repeat(20); // ~260 chars
    const longCode = "line1\nline2\nline3\nline4\nline5\nline6\n" + "x".repeat(600);
    // Message is ~260 + ~600 = ~900 chars, code is ~66% - triggers code block truncation
    // Actually need code to be <50% for this path. Let's try different approach.

    // Make message ~1200 chars with code being <50%
    const text = "A".repeat(700); // 700 chars text
    const code = "line1\nline2\nline3\nline4\nline5\nline6\n" + "B".repeat(500); // ~550 chars code
    const content = `${text}\n\`\`\`typescript\n${code}\n\`\`\``;

    const context = {
      sessionId: "test",
      projectPath: "/project",
      filesRead: [],
      filesWritten: [],
      filesEdited: [],
      fileContents: new Map(),
      conversation: [
        { role: "assistant" as const, content, timestamp: "" },
      ],
    };

    const result = formatConversationContext(context);

    // Should truncate code block to show preview + "see Files section"
    expect(result).toContain("truncated - see Files section");
    // Should preserve some preview lines
    expect(result).toContain("line1");
  });

  it("includes note about stale code", () => {
    const context = {
      sessionId: "test",
      projectPath: "/project",
      filesRead: [],
      filesWritten: [],
      filesEdited: [],
      fileContents: new Map(),
      conversation: [
        { role: "user" as const, content: "Test", timestamp: "" },
      ],
    };

    const result = formatConversationContext(context);

    expect(result).toContain("Code snippets in conversation may be outdated");
    expect(result).toContain("Files section for current code");
  });
});

describe("parseSession - tool_result variations", () => {
  let projectDir: string;
  let projectPath: string;

  beforeAll(() => {
    projectPath = "/Users/test/toolresultproject";
    projectDir = path.join(mockProjectsDir, "-Users-test-toolresultproject");
    fs.mkdirSync(projectDir, { recursive: true });

    createMockSessionIndex(projectDir, [
      { sessionId: "tool-result-test" },
    ], projectPath);
  });

  afterAll(() => {
    cleanupTempDir(projectDir);
  });

  it("handles tool_result with object content (not string)", () => {
    const toolUseId = "read-obj-1";
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: toolUseId, name: "Read", input: { file_path: "/project/file.ts" } },
          ],
        },
        timestamp: new Date().toISOString(),
      }),
      // Top-level tool_result with object content
      JSON.stringify({
        type: "tool_result",
        tool_use_id: toolUseId,
        content: { data: "complex object content", lines: 100 },
      }),
    ];

    fs.writeFileSync(path.join(projectDir, "tool-result-test.jsonl"), lines.join("\n"));
    const result = parseSession(projectPath, "tool-result-test");

    expect(result).not.toBeNull();
    expect(result!.fileContents.get("/project/file.ts")).toContain("complex object content");
  });

  it("handles orphaned tool_result (no matching tool_use)", () => {
    const lines = [
      JSON.stringify({
        type: "tool_result",
        tool_use_id: "nonexistent-id",
        content: "orphaned content",
      }),
    ];

    fs.writeFileSync(path.join(projectDir, "tool-result-test.jsonl"), lines.join("\n"));
    const result = parseSession(projectPath, "tool-result-test");

    // Should not throw, orphan is ignored
    expect(result).not.toBeNull();
    expect(result!.fileContents.size).toBe(0);
  });

  it("handles tool_result for non-Read operations", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "write-1", name: "Write", input: { file_path: "/project/new.ts", content: "code" } },
          ],
        },
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: "tool_result",
        tool_use_id: "write-1",
        content: "File written successfully",
      }),
    ];

    fs.writeFileSync(path.join(projectDir, "tool-result-test.jsonl"), lines.join("\n"));
    const result = parseSession(projectPath, "tool-result-test");

    // Write result should not populate fileContents from tool_result
    // (content comes from tool_use input, not result)
    expect(result!.filesWritten).toContain("/project/new.ts");
    expect(result!.fileContents.get("/project/new.ts")).toBe("code");
  });

  it("handles tool_result nested in user message content", () => {
    const toolUseId = "read-nested-1";
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: toolUseId, name: "Read", input: { file_path: "/project/nested.ts" } },
          ],
        },
        timestamp: new Date().toISOString(),
      }),
      // tool_result nested inside message.content array (user message format)
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: toolUseId, content: "nested result content" },
          ],
        },
        timestamp: new Date().toISOString(),
      }),
    ];

    fs.writeFileSync(path.join(projectDir, "tool-result-test.jsonl"), lines.join("\n"));
    const result = parseSession(projectPath, "tool-result-test");

    expect(result!.fileContents.get("/project/nested.ts")).toBe("nested result content");
  });

  it("handles tool_result nested in assistant message content blocks", () => {
    // This tests lines 304-316 where tool_result is inside assistant message content array
    const toolUseId = "read-assistant-nested-1";
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: toolUseId, name: "Read", input: { file_path: "/project/assistant-nested.ts" } },
            // Tool result in same assistant message (some Claude Code versions)
            { type: "tool_result", tool_use_id: toolUseId, content: "assistant nested content" },
          ],
        },
        timestamp: new Date().toISOString(),
      }),
    ];

    fs.writeFileSync(path.join(projectDir, "tool-result-test.jsonl"), lines.join("\n"));
    const result = parseSession(projectPath, "tool-result-test");

    expect(result!.fileContents.get("/project/assistant-nested.ts")).toBe("assistant nested content");
  });
});

describe("parseSession - resolvePersistedContent", () => {
  let projectDir: string;
  let projectPath: string;

  beforeAll(() => {
    projectPath = "/Users/test/persistedproject";
    projectDir = path.join(mockProjectsDir, "-Users-test-persistedproject");
    fs.mkdirSync(projectDir, { recursive: true });

    createMockSessionIndex(projectDir, [
      { sessionId: "persisted-test" },
    ], projectPath);
  });

  afterAll(() => {
    cleanupTempDir(projectDir);
  });

  it("resolves persisted content from saved file", () => {
    // Create the persisted output file
    const persistedFile = path.join(projectDir, "tool-results", "output-123.txt");
    fs.mkdirSync(path.dirname(persistedFile), { recursive: true });
    fs.writeFileSync(persistedFile, "Full file content from disk");

    const toolUseId = "read-persisted-1";
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: toolUseId, name: "Read", input: { file_path: "/project/big.ts" } },
          ],
        },
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: "tool_result",
        tool_use_id: toolUseId,
        content: `<persisted-output>\nTruncated...\nFull output saved to: tool-results/output-123.txt\n</persisted-output>`,
      }),
    ];

    fs.writeFileSync(path.join(projectDir, "persisted-test.jsonl"), lines.join("\n"));
    const result = parseSession(projectPath, "persisted-test");

    expect(result!.fileContents.get("/project/big.ts")).toBe("Full file content from disk");
  });

  it("falls back to original content when persisted file missing", () => {
    const toolUseId = "read-missing-1";
    const originalContent = `<persisted-output>\nTruncated content...\nFull output saved to: /nonexistent/path.txt\n</persisted-output>`;
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: toolUseId, name: "Read", input: { file_path: "/project/file.ts" } },
          ],
        },
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: "tool_result",
        tool_use_id: toolUseId,
        content: originalContent,
      }),
    ];

    fs.writeFileSync(path.join(projectDir, "persisted-test.jsonl"), lines.join("\n"));
    const result = parseSession(projectPath, "persisted-test");

    // Should use original content (with persisted marker) as fallback
    expect(result!.fileContents.get("/project/file.ts")).toContain("persisted-output");
  });
});

describe("parseSession - message content variations", () => {
  let projectDir: string;
  let projectPath: string;

  beforeAll(() => {
    projectPath = "/Users/test/msgvariations";
    projectDir = path.join(mockProjectsDir, "-Users-test-msgvariations");
    fs.mkdirSync(projectDir, { recursive: true });

    createMockSessionIndex(projectDir, [
      { sessionId: "msg-test" },
    ], projectPath);
  });

  afterAll(() => {
    cleanupTempDir(projectDir);
  });

  it("handles user message with null content", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        message: { content: null },
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: "user",
        message: { content: "Valid message" },
        timestamp: new Date().toISOString(),
      }),
    ];

    fs.writeFileSync(path.join(projectDir, "msg-test.jsonl"), lines.join("\n"));
    const result = parseSession(projectPath, "msg-test");

    // Should skip null content and parse valid message
    expect(result!.conversation).toHaveLength(1);
    expect(result!.conversation[0].content).toBe("Valid message");
  });

  it("handles assistant message with non-array content", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: "Direct string response", // Not array
        },
        timestamp: new Date().toISOString(),
      }),
    ];

    fs.writeFileSync(path.join(projectDir, "msg-test.jsonl"), lines.join("\n"));
    const result = parseSession(projectPath, "msg-test");

    // Should handle gracefully (wraps in array internally)
    expect(result).not.toBeNull();
  });

  it("handles message with missing content key", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        message: { timestamp: "2024-01-01" }, // No content
        timestamp: new Date().toISOString(),
      }),
    ];

    fs.writeFileSync(path.join(projectDir, "msg-test.jsonl"), lines.join("\n"));
    const result = parseSession(projectPath, "msg-test");

    // Should skip message without content
    expect(result!.conversation).toHaveLength(0);
  });

  it("handles user message with object content", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        message: {
          content: { complex: "object", with: ["array"] },
        },
        timestamp: new Date().toISOString(),
      }),
    ];

    fs.writeFileSync(path.join(projectDir, "msg-test.jsonl"), lines.join("\n"));
    const result = parseSession(projectPath, "msg-test");

    // Should stringify the object content
    expect(result!.conversation).toHaveLength(1);
    expect(result!.conversation[0].content).toContain("complex");
  });
});

describe("parseSession - tool_use input edge cases", () => {
  let projectDir: string;
  let projectPath: string;

  beforeAll(() => {
    projectPath = "/Users/test/toolinputproject";
    projectDir = path.join(mockProjectsDir, "-Users-test-toolinputproject");
    fs.mkdirSync(projectDir, { recursive: true });

    createMockSessionIndex(projectDir, [
      { sessionId: "tool-input-test" },
    ], projectPath);
  });

  afterAll(() => {
    cleanupTempDir(projectDir);
  });

  it("handles tool_use with missing input object", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "read-1", name: "Read" }, // No input
          ],
        },
        timestamp: new Date().toISOString(),
      }),
    ];

    fs.writeFileSync(path.join(projectDir, "tool-input-test.jsonl"), lines.join("\n"));
    const result = parseSession(projectPath, "tool-input-test");

    expect(result!.filesRead).toHaveLength(0);
  });

  it("handles tool_use with input missing file_path", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "read-1", name: "Read", input: {} }, // Empty input
          ],
        },
        timestamp: new Date().toISOString(),
      }),
    ];

    fs.writeFileSync(path.join(projectDir, "tool-input-test.jsonl"), lines.join("\n"));
    const result = parseSession(projectPath, "tool-input-test");

    expect(result!.filesRead).toHaveLength(0);
  });

  it("handles Edit tool_use with missing file_path", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "edit-1",
              name: "Edit",
              input: { old_string: "old", new_string: "new" }, // Missing file_path
            },
          ],
        },
        timestamp: new Date().toISOString(),
      }),
    ];

    fs.writeFileSync(path.join(projectDir, "tool-input-test.jsonl"), lines.join("\n"));
    const result = parseSession(projectPath, "tool-input-test");

    expect(result!.filesEdited).toHaveLength(0);
  });
});

describe("formatConversationContext - code block truncation edge cases", () => {
  it("omits code blocks when content is mostly code (>50%)", () => {
    // When code is >50% of message AND >500 chars, it gets replaced with omitted message
    const singleLine = "x".repeat(600);
    const content = `Text\n\`\`\`typescript\n${singleLine}\n\`\`\``;

    const context = {
      sessionId: "test",
      projectPath: "/project",
      filesRead: [],
      filesWritten: [],
      filesEdited: [],
      fileContents: new Map(),
      conversation: [
        { role: "assistant" as const, content, timestamp: "" },
      ],
    };

    const result = formatConversationContext(context);

    // Should omit because code is >50% of content and >500 chars
    expect(result).toContain("code snippet omitted");
  });

  it("preserves small code blocks under truncation threshold", () => {
    // Code block under 500 chars total (including backticks and language marker)
    // The block is: ```ts\n + content + \n``` = ~10 chars overhead
    // So keep content under ~490 chars to stay under 500 total
    const smallContent = "x".repeat(480);
    // Add lots of text so code is <50% of message
    const textPadding = "This is some explanatory text. ".repeat(30); // ~900 chars
    const content = `${textPadding}\n\`\`\`ts\n${smallContent}\n\`\`\``;

    const context = {
      sessionId: "test",
      projectPath: "/project",
      filesRead: [],
      filesWritten: [],
      filesEdited: [],
      fileContents: new Map(),
      conversation: [
        { role: "assistant" as const, content, timestamp: "" },
      ],
    };

    const result = formatConversationContext(context);

    // Block under 500 chars total should NOT be truncated
    expect(result).not.toContain("truncated");
    expect(result).not.toContain("omitted");
    // The x's should be preserved
    expect(result).toContain("xxxx");
  });

  it("handles empty code block", () => {
    const content = "Text before\n```\n\n```\nText after";

    const context = {
      sessionId: "test",
      projectPath: "/project",
      filesRead: [],
      filesWritten: [],
      filesEdited: [],
      fileContents: new Map(),
      conversation: [
        { role: "assistant" as const, content, timestamp: "" },
      ],
    };

    const result = formatConversationContext(context);

    // Should not crash, should preserve structure
    expect(result).toContain("Text before");
    expect(result).toContain("Text after");
  });

  it("truncates large code blocks when message is not mostly code", () => {
    // Lots of text so code is <50%, but code block is >500 chars
    const textPadding = "This is explanatory text with details. ".repeat(50); // ~2000 chars
    const largeCode = "line1\nline2\nline3\nline4\nline5\nline6\n" + "y".repeat(600); // ~640 chars
    const content = `${textPadding}\n\`\`\`js\n${largeCode}\n\`\`\``;

    const context = {
      sessionId: "test",
      projectPath: "/project",
      filesRead: [],
      filesWritten: [],
      filesEdited: [],
      fileContents: new Map(),
      conversation: [
        { role: "assistant" as const, content, timestamp: "" },
      ],
    };

    const result = formatConversationContext(context);

    // Code is <50%, but block >500 chars, so individual block gets truncated
    expect(result).toContain("truncated");
    // Should preserve preview lines
    expect(result).toContain("line1");
  });
});

describe("parseSession - empty/whitespace files", () => {
  let projectDir: string;
  let projectPath: string;

  beforeAll(() => {
    projectPath = "/Users/test/emptyfileproject";
    projectDir = path.join(mockProjectsDir, "-Users-test-emptyfileproject");
    fs.mkdirSync(projectDir, { recursive: true });

    createMockSessionIndex(projectDir, [
      { sessionId: "empty-test" },
    ], projectPath);
  });

  afterAll(() => {
    cleanupTempDir(projectDir);
  });

  it("handles empty session file", () => {
    fs.writeFileSync(path.join(projectDir, "empty-test.jsonl"), "");
    const result = parseSession(projectPath, "empty-test");

    expect(result!.conversation).toHaveLength(0);
    expect(result!.filesRead).toHaveLength(0);
  });

  it("handles session file with only whitespace", () => {
    fs.writeFileSync(path.join(projectDir, "empty-test.jsonl"), "\n\n\n   \n");
    const result = parseSession(projectPath, "empty-test");

    expect(result!.conversation).toHaveLength(0);
    expect(result!.filesRead).toHaveLength(0);
  });

  it("handles session file with blank lines between valid entries", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        message: { content: "First message" },
        timestamp: new Date().toISOString(),
      }),
      "",
      "   ",
      JSON.stringify({
        type: "user",
        message: { content: "Second message" },
        timestamp: new Date().toISOString(),
      }),
    ];

    fs.writeFileSync(path.join(projectDir, "empty-test.jsonl"), lines.join("\n"));
    const result = parseSession(projectPath, "empty-test");

    expect(result!.conversation).toHaveLength(2);
    expect(result!.conversation[0].content).toBe("First message");
    expect(result!.conversation[1].content).toBe("Second message");
  });
});

// Cleanup mock projects dir at the end
afterAll(() => {
  cleanupTempDir(mockProjectsDir);
});
