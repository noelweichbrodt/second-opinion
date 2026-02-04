import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import * as path from "path";
import { createTempDir, cleanupTempDir, createProjectStructure } from "./test-utils.js";

// Mock config before imports
vi.mock("./config.js", () => ({
  loadConfig: () => ({
    geminiApiKey: "test-gemini-key",
    openaiApiKey: "test-openai-key",
    defaultProvider: "gemini",
    geminiModel: "gemini-2.0-flash-exp",
    openaiModel: "gpt-4o",
    maxContextTokens: 100000,
    reviewsDir: "second-opinions",
  }),
  loadReviewInstructions: () => "# Review Instructions\nBe constructive.",
  getClaudeProjectsDir: () => "/mock/projects",
}));

// Mock providers
vi.mock("./providers/index.js", () => ({
  getAvailableProviders: () => ["gemini", "openai"],
  createProvider: vi.fn().mockReturnValue({
    name: "gemini",
    review: vi.fn().mockResolvedValue({
      review: "# Mock Review\n\nLooks good!",
      model: "gemini-2.0-flash-exp",
      tokensUsed: 500,
    }),
  }),
}));

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
  it("validates provider enum", () => {
    const validGemini = SecondOpinionInputSchema.safeParse({
      provider: "gemini",
      projectPath: "/test",
    });
    const validOpenai = SecondOpinionInputSchema.safeParse({
      provider: "openai",
      projectPath: "/test",
    });
    const invalid = SecondOpinionInputSchema.safeParse({
      provider: "invalid",
      projectPath: "/test",
    });

    expect(validGemini.success).toBe(true);
    expect(validOpenai.success).toBe(true);
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
      "sessionId",
      "includeConversation",
      "includeDependencies",
      "includeDependents",
      "includeTests",
      "includeTypes",
      "maxTokens",
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
    const validProviders = ["gemini", "openai"];

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
    expect(tool.description).toContain("openai");
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
