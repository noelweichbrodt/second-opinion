import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import * as path from "path";
import { createTempDir, cleanupTempDir, createProjectStructure } from "./test-utils.js";

// Mock config before imports
vi.mock("./config.js", () => ({
  loadConfig: () => ({
    geminiApiKey: "test-gemini-key",
    geminiModel: "gemini-2.0-flash-exp",
    codexModel: "gpt-5.6-sol",
    maxContextTokens: 100000,
    maxOutputTokens: 32768,
    reviewsDir: "second-opinions",
    temperature: 0.3,
    rateLimitWindowMs: 60000,
    rateLimitMaxRequests: 10,
  }),
  loadReviewInstructions: () => "# Review Instructions\nBe constructive.",
  getClaudeProjectsDir: () => "/mock/projects",
}));

// Mock API-backed provider behavior while retaining the real Codex prompt and
// rescue-command helpers used by the handoff path.
vi.mock("./providers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers/index.js")>();

  return {
    ...actual,
    getAvailableProviders: () => ["gemini", "codex", "consensus"],
    createProvider: vi.fn().mockReturnValue({
      name: "gemini",
      review: vi.fn().mockResolvedValue({
        review: "# Mock Review\n\nLooks good!",
        model: "gemini-2.0-flash-exp",
        tokensUsed: 500,
      }),
    }),
    getConsensusReview: vi.fn(
      async (
        _request: unknown,
        _config: unknown,
        handoff: unknown
      ) => ({
        gemini: {
          review: "G".repeat(1200),
          model: "gemini-2.0-flash-exp",
          tokensUsed: 400,
        },
        codex: handoff,
      })
    ),
  };
});

// Store handlers captured from the Server mock
type RequestHandler = (request: unknown) => Promise<unknown>;
const capturedHandlers: Map<string, RequestHandler> = new Map();

// Mock MCP SDK - capture handlers when setRequestHandler is called
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class MockServer {
    setRequestHandler(schema: { method: string }, handler: RequestHandler) {
      capturedHandlers.set(schema.method, handler);
    }
    async connect() {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class MockTransport {},
}));

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  ListToolsRequestSchema: { method: "tools/list" },
  CallToolRequestSchema: { method: "tools/call" },
}));

// Import the actual executeReview and schema to test the real behavior
import { SecondOpinionInputSchema, executeReview } from "./tools/review.js";
// Import createServer to test it
import { createServer, runServer } from "./server.js";

describe("SecondOpinionInputSchema validation", () => {
  it("validates providers and normalizes the deprecated openai alias", () => {
    const validGemini = SecondOpinionInputSchema.safeParse({
      provider: "gemini",
      projectPath: "/test",
    });
    const validCodex = SecondOpinionInputSchema.safeParse({
      provider: "codex",
      projectPath: "/test",
    });
    const validConsensus = SecondOpinionInputSchema.safeParse({
      provider: "consensus",
      projectPath: "/test",
    });
    const deprecatedOpenai = SecondOpinionInputSchema.safeParse({
      provider: "openai",
      projectPath: "/test",
    });
    const invalid = SecondOpinionInputSchema.safeParse({
      provider: "invalid",
      projectPath: "/test",
    });

    expect(validGemini.success).toBe(true);
    expect(validCodex.success).toBe(true);
    expect(validConsensus.success).toBe(true);
    expect(deprecatedOpenai.success).toBe(true);
    if (deprecatedOpenai.success) {
      expect(deprecatedOpenai.data.provider).toBe("codex");
    }
    expect(invalid.success).toBe(false);
  });

  it("requires provider and projectPath", () => {
    const missingProvider = SecondOpinionInputSchema.safeParse({
      projectPath: "/test",
    });
    const missingPath = SecondOpinionInputSchema.safeParse({
      provider: "gemini",
    });

    expect(missingProvider.success).toBe(false);
    expect(missingPath.success).toBe(false);
  });

  it("applies default values", () => {
    const result = SecondOpinionInputSchema.parse({
      provider: "gemini",
      projectPath: "/test",
    });

    expect(result.includeConversation).toBe(true);
    expect(result.includeDependencies).toBe(true);
    expect(result.includeDependents).toBe(true);
    expect(result.includeTests).toBe(true);
    expect(result.includeTypes).toBe(true);
    expect(result.dryRun).toBe(false);
  });
});

describe("executeReview integration", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("server-integration");
    createProjectStructure(tmpDir, {
      "src/index.ts": "export const main = 1;",
      "src/utils.ts": "export const helper = 2;",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes dry run without calling provider", async () => {
    const result = await executeReview({
      provider: "gemini",
      projectPath: tmpDir,
      includeFiles: ["src/index.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.provider).toBe("gemini");
    expect(result.summary).toBeDefined();
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it("executes actual review and creates files", async () => {
    const result = await executeReview({
      provider: "gemini",
      projectPath: tmpDir,
      includeFiles: ["src/index.ts"],
      includeConversation: false,
      includeDependencies: false,
      includeDependents: false,
      includeTests: false,
      includeTypes: false,
      dryRun: false,
    });

    if (result.dryRun) throw new Error("Expected actual review");

    expect(result.review).toBeDefined();
    expect(result.reviewFile).toContain(".md");
    expect(result.egressManifestFile).toContain(".egress.json");
    expect(result.provider).toBe("gemini");
    expect(result.model).toBeDefined();
  });

  it("throws on invalid projectPath", async () => {
    await expect(
      executeReview({
        provider: "gemini",
        projectPath: "/nonexistent/path",
        includeConversation: false,
        includeDependencies: false,
        includeDependents: false,
        includeTests: false,
        includeTypes: false,
        dryRun: true,
      })
    ).rejects.toThrow();
  });

  it("throws on relative projectPath", async () => {
    await expect(
      executeReview({
        provider: "gemini",
        projectPath: "relative/path",
        includeConversation: false,
        includeDependencies: false,
        includeDependents: false,
        includeTests: false,
        includeTypes: false,
        dryRun: true,
      })
    ).rejects.toThrow("absolute");
  });
});

describe("Response structures", () => {
  it("dry run response has expected fields", () => {
    // Test the expected structure of dry run responses
    const dryRunResponse = {
      dryRun: true,
      provider: "gemini",
      summary: {
        projectFilesSent: 5,
        projectFilePaths: ["/a.ts", "/b.ts"],
        externalFilesSent: 0,
        externalFilePaths: [],
        externalLocations: [],
        blockedFiles: [],
        provider: "gemini",
      },
      totalTokens: 1000,
    };

    expect(dryRunResponse.dryRun).toBe(true);
    expect(dryRunResponse.summary.projectFilesSent).toBe(5);
    expect(dryRunResponse.totalTokens).toBe(1000);
    expect(Array.isArray(dryRunResponse.summary.projectFilePaths)).toBe(true);
    expect(Array.isArray(dryRunResponse.summary.blockedFiles)).toBe(true);
  });

  it("actual review response has expected fields", () => {
    // Test the expected structure of review responses
    const reviewResponse = {
      success: true,
      reviewFile: "/project/second-opinions/review.md",
      egressManifestFile: "/project/second-opinions/review.egress.json",
      provider: "gemini",
      model: "gemini-2.0-flash-exp",
      filesReviewed: 5,
      contextTokens: 1000,
      tokensUsed: 500,
      summary: {
        projectFilesSent: 5,
        projectFilePaths: [],
        externalFilesSent: 0,
        externalFilePaths: [],
        externalLocations: [],
        blockedFiles: [],
        provider: "gemini",
      },
      reviewPreview: "# Review\n\nLooks good!...",
    };

    expect(reviewResponse.success).toBe(true);
    expect(reviewResponse.reviewFile).toContain(".md");
    expect(reviewResponse.egressManifestFile).toContain(".egress.json");
    expect(typeof reviewResponse.filesReviewed).toBe("number");
    expect(typeof reviewResponse.contextTokens).toBe("number");
    expect(typeof reviewResponse.tokensUsed).toBe("number");
  });

  it("error response has expected fields", () => {
    const errorResponse = {
      success: false,
      error: "API Error: rate limit exceeded",
    };

    expect(errorResponse.success).toBe(false);
    expect(typeof errorResponse.error).toBe("string");
  });

  it("review preview is truncated for long reviews", () => {
    const longReview = "x".repeat(1000);
    const preview = longReview.substring(0, 500) + (longReview.length > 500 ? "..." : "");

    expect(preview.length).toBe(503); // 500 + "..."
    expect(preview.endsWith("...")).toBe(true);
  });
});

describe("Tool schema structure", () => {
  it("defines correct tool properties", () => {
    // Verify the expected properties that would be in the tool schema
    const expectedProperties = [
      "provider",
      "projectPath",
      "task",
      "sessionId",
      "includeConversation",
      "includeDependencies",
      "includeDependents",
      "includeTests",
      "includeTypes",
      "maxInputTokens",
      "maxOutputTokens",
      "prNumber",
      "temperature",
      "sessionName",
      "customPrompt",
      "focusAreas",
      "includeFiles",
      "allowExternalFiles",
      "dryRun",
    ];

    // These are the properties defined in the input schema
    const schemaKeys = Object.keys(SecondOpinionInputSchema.shape);

    for (const prop of expectedProperties) {
      expect(schemaKeys).toContain(prop);
    }
  });

  it("provider enum contains expected values", () => {
    const validProviders = ["gemini", "codex", "consensus", "openai"];

    for (const provider of validProviders) {
      const result = SecondOpinionInputSchema.safeParse({
        provider,
        projectPath: "/test",
      });
      expect(result.success).toBe(true);
    }
  });
});

describe("createServer", () => {
  beforeEach(() => {
    capturedHandlers.clear();
  });

  it("creates a server instance", () => {
    const server = createServer();
    expect(server).toBeDefined();
  });

  it("registers tools/list handler", () => {
    createServer();
    expect(capturedHandlers.has("tools/list")).toBe(true);
  });

  it("registers tools/call handler", () => {
    createServer();
    expect(capturedHandlers.has("tools/call")).toBe(true);
  });
});

describe("ListToolsRequestSchema handler", () => {
  beforeEach(() => {
    capturedHandlers.clear();
    createServer();
  });

  it("returns tool list with second_opinion", async () => {
    const handler = capturedHandlers.get("tools/list");
    const result = await handler!({});

    expect(result).toHaveProperty("tools");
    expect((result as { tools: unknown[] }).tools).toHaveLength(1);
    expect((result as { tools: { name: string }[] }).tools[0].name).toBe("second_opinion");
  });

  it("includes available providers in description", async () => {
    const handler = capturedHandlers.get("tools/list");
    const result = await handler!({});

    const tool = (result as { tools: { description: string }[] }).tools[0];
    expect(tool.description).toContain("gemini");
    expect(tool.description).toContain("codex");
    expect(tool.description).toContain("consensus");
    expect(tool.description).toContain("/codex:rescue");
  });

  it("includes correct input schema properties", async () => {
    const handler = capturedHandlers.get("tools/list");
    const result = await handler!({});

    const tool = (result as { tools: { inputSchema: { properties: Record<string, unknown> } }[] }).tools[0];
    expect(tool.inputSchema.properties).toHaveProperty("provider");
    expect(tool.inputSchema.properties).toHaveProperty("projectPath");
    expect(tool.inputSchema.properties).toHaveProperty("dryRun");
    expect(tool.inputSchema.properties).toHaveProperty("includeFiles");
  });

  it("describes the provider enum and temperature's Gemini-only scope", async () => {
    const handler = capturedHandlers.get("tools/list");
    const result = await handler!({});

    const tool = (result as {
      tools: {
        inputSchema: {
          properties: Record<
            string,
            { enum?: string[]; description?: string }
          >;
        };
      }[];
    }).tools[0];
    const provider = tool.inputSchema.properties.provider;
    const temperature = tool.inputSchema.properties.temperature;

    expect(provider.enum).toEqual([
      "gemini",
      "codex",
      "consensus",
      "openai",
    ]);
    expect(provider.description).toContain(
      "'openai' is a deprecated alias for 'codex'"
    );
    expect(temperature.description).toContain("Gemini-only");
    expect(temperature.description).toContain("ignored for codex");
  });

  it("derives the wire schema from the zod schema (parity guard)", async () => {
    const handler = capturedHandlers.get("tools/list");
    const result = await handler!({});
    const tool = (result as {
      tools: {
        inputSchema: {
          type: string;
          properties: Record<string, Record<string, unknown>>;
          required: string[];
        };
      }[];
    }).tools[0];
    const schema = tool.inputSchema;

    // Same property set as the zod validator — a field added or removed in
    // SecondOpinionInputSchema must show up here without manual sync.
    const zodKeys = Object.keys(SecondOpinionInputSchema.shape).sort();
    expect(Object.keys(schema.properties).sort()).toEqual(zodKeys);

    // Constraint semantics survive generation.
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["provider", "projectPath"]);
    expect(schema.properties.temperature.minimum).toBe(0);
    expect(schema.properties.temperature.maximum).toBe(1);
    expect(schema.properties.includeConversation.default).toBe(true);
    expect(schema.properties.allowExternalFiles.default).toBe(false);
    expect(schema.properties.dryRun.default).toBe(false);
    expect(schema.properties.includeFiles.type).toBe("array");
  });

  it("keeps the tools/list wire message within the token budget", async () => {
    const handler = capturedHandlers.get("tools/list");
    const result = await handler!({});
    const wire =
      JSON.stringify({ jsonrpc: "2.0", id: 1, result }) + "\n";

    // Audit acceptance (plans/token-audit.md S2): the definition rides in
    // every MCP session's context. Raising this ceiling is a deliberate,
    // reviewed decision — not a side effect.
    expect(Buffer.byteLength(wire, "utf-8")).toBeLessThanOrEqual(2433);
  });
});

describe("CallToolRequestSchema handler", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("server-call-test");
    createProjectStructure(tmpDir, {
      "src/index.ts": "export const main = 1;",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();
    createServer();
  });

  it("throws for unknown tool", async () => {
    const handler = capturedHandlers.get("tools/call");
    const request = {
      params: {
        name: "unknown_tool",
        arguments: {},
      },
    };

    await expect(handler!(request)).rejects.toThrow("Unknown tool");
  });

  it("handles dry run request", async () => {
    const handler = capturedHandlers.get("tools/call");
    const request = {
      params: {
        name: "second_opinion",
        arguments: {
          provider: "gemini",
          projectPath: tmpDir,
          includeFiles: ["src/index.ts"],
          includeConversation: false,
          includeDependencies: false,
          includeDependents: false,
          includeTests: false,
          includeTypes: false,
          dryRun: true,
        },
      },
    };

    const result = await handler!(request);

    expect(result).toHaveProperty("content");
    const content = (result as { content: { text: string }[] }).content[0].text;
    const parsed = JSON.parse(content);
    expect(parsed.dryRun).toBe(true);
  });

  it("handles actual review request", async () => {
    const handler = capturedHandlers.get("tools/call");
    const request = {
      params: {
        name: "second_opinion",
        arguments: {
          provider: "gemini",
          projectPath: tmpDir,
          includeFiles: ["src/index.ts"],
          includeConversation: false,
          includeDependencies: false,
          includeDependents: false,
          includeTests: false,
          includeTypes: false,
          dryRun: false,
        },
      },
    };

    const result = await handler!(request);

    expect(result).toHaveProperty("content");
    const content = (result as { content: { text: string }[] }).content[0].text;
    const parsed = JSON.parse(content);
    expect(parsed.success).toBe(true);
    expect(parsed.reviewFile).toBeDefined();
    expect(parsed.egressManifestFile).toBeDefined();
  });

  it("returns the complete Codex handoff without a review preview", async () => {
    const handler = capturedHandlers.get("tools/call");
    const request = {
      params: {
        name: "second_opinion",
        arguments: {
          provider: "codex",
          projectPath: tmpDir,
          sessionName: "codex-handoff-response",
          includeFiles: ["src/index.ts"],
          includeConversation: false,
          includeDependencies: false,
          includeDependents: false,
          includeTests: false,
          includeTypes: false,
          dryRun: false,
        },
      },
    };

    const result = await handler!(request);

    expect(result).toHaveProperty("content");
    const content = (result as { content: { text: string }[] }).content[0].text;
    const parsed = JSON.parse(content);

    expect(parsed).toMatchObject({
      handoff: true,
      provider: "codex",
      model: "gpt-5.6-sol",
      filesReviewed: expect.any(Number),
      contextTokens: expect.any(Number),
      egress: {
        provider: "codex",
        projectFilesSent: expect.any(Number),
        externalFilesSent: expect.any(Number),
        blockedFiles: expect.any(Number),
        redactions: expect.any(Number),
      },
    });
    // Full path arrays live in the egress manifest, not the tool result.
    expect(parsed).not.toHaveProperty("summary");
    expect(parsed.egress).not.toHaveProperty("projectFilePaths");
    expect(path.isAbsolute(parsed.promptFile)).toBe(true);
    expect(parsed.promptFile).toMatch(/\.prompt\.md$/);
    expect(path.isAbsolute(parsed.reviewFile)).toBe(true);
    expect(parsed.reviewFile).toMatch(/\.md$/);
    expect(path.isAbsolute(parsed.egressManifestFile)).toBe(true);
    expect(parsed.egressManifestFile).toMatch(/\.egress\.json$/);
    expect(parsed.rescueCommand).toContain(
      "/codex:rescue --model gpt-5.6-sol --fresh"
    );
    expect(parsed.rescueCommand).toContain(parsed.promptFile);
    expect(parsed.rescueCommand).not.toContain("--effort");
    expect(parsed.verifyCommand).toContain("verify-review.js");
    expect(parsed.verifyCommand).toContain(parsed.reviewFile);
    expect(parsed.spliceCommand).toContain("splice-codex-result.js");
    // JOB_ID is deliberately metacharacter-free (`<job-id>` would be a Bash
    // redirection).
    expect(parsed.spliceCommand).toContain(" JOB_ID ");
    expect(parsed.spliceCommand).not.toContain("<");
    expect(parsed).not.toHaveProperty("reviewPreview");
    // Key absent entirely (not null/undefined) when there are no warnings —
    // that is what keeps the lean response lean.
    expect("budgetWarnings" in parsed).toBe(false);
  });

  it("surfaces budget warnings on non-dry-run responses when reductions happened", async () => {
    const handler = capturedHandlers.get("tools/call");
    const bigDir = createTempDir("server-budget-warn");
    createProjectStructure(bigDir, {
      "src/big.ts": `// filler\n${"const x = 1;\n".repeat(3000)}`,
    });

    try {
      const request = {
        params: {
          name: "second_opinion",
          arguments: {
            provider: "codex",
            projectPath: bigDir,
            sessionName: "budget-warning-response",
            includeFiles: ["src/big.ts"],
            maxInputTokens: 100,
            includeConversation: false,
            includeDependencies: false,
            includeDependents: false,
            includeTests: false,
            includeTypes: false,
            dryRun: false,
          },
        },
      };

      const result = await handler!(request);
      const content = (result as { content: { text: string }[] }).content[0].text;
      const parsed = JSON.parse(content);

      expect(parsed.handoff).toBe(true);
      expect(Array.isArray(parsed.budgetWarnings)).toBe(true);
      expect(parsed.budgetWarnings.length).toBeGreaterThan(0);
      for (const warning of parsed.budgetWarnings) {
        expect(typeof warning).toBe("string");
      }
    } finally {
      cleanupTempDir(bigDir);
    }
  });

  it("serializes only a Gemini preview in the consensus handoff response", async () => {
    const handler = capturedHandlers.get("tools/call");
    const request = {
      params: {
        name: "second_opinion",
        arguments: {
          provider: "consensus",
          projectPath: tmpDir,
          sessionName: "consensus-preview-response",
          includeFiles: ["src/index.ts"],
          includeConversation: false,
          includeDependencies: false,
          includeDependents: false,
          includeTests: false,
          includeTypes: false,
          dryRun: false,
        },
      },
    };

    const result = await handler!(request);

    const content = (result as { content: { text: string }[] }).content[0].text;
    const parsed = JSON.parse(content);

    expect(parsed.handoff).toBe(true);
    expect(parsed.provider).toBe("consensus");
    // The full Gemini review lives in reviewFile, which Claude reads once for
    // synthesis — the consensus result carries status only, no preview.
    expect(parsed.gemini.model).toBe("gemini-2.0-flash-exp");
    expect(parsed.gemini.tokensUsed).toBe(400);
    expect(parsed.gemini).not.toHaveProperty("review");
    expect(parsed.gemini).not.toHaveProperty("reviewPreview");
  });

  it("handles validation errors", async () => {
    const handler = capturedHandlers.get("tools/call");
    const request = {
      params: {
        name: "second_opinion",
        arguments: {
          provider: "invalid-provider",
          projectPath: tmpDir,
        },
      },
    };

    const result = await handler!(request);

    expect(result).toHaveProperty("isError", true);
    const content = (result as { content: { text: string }[] }).content[0].text;
    const parsed = JSON.parse(content);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeDefined();
  });

  it("handles execution errors", async () => {
    const handler = capturedHandlers.get("tools/call");
    const request = {
      params: {
        name: "second_opinion",
        arguments: {
          provider: "gemini",
          projectPath: "/nonexistent/path",
        },
      },
    };

    const result = await handler!(request);

    expect(result).toHaveProperty("isError", true);
    const content = (result as { content: { text: string }[] }).content[0].text;
    const parsed = JSON.parse(content);
    expect(parsed.success).toBe(false);
  });
});

describe("runServer", () => {
  beforeEach(() => {
    capturedHandlers.clear();
  });

  it("creates server and connects transport", async () => {
    await runServer();

    // Verify handlers were registered
    expect(capturedHandlers.has("tools/list")).toBe(true);
    expect(capturedHandlers.has("tools/call")).toBe(true);
  });
});
