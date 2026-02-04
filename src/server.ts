import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  SecondOpinionInputSchema,
  executeReview,
} from "./tools/review.js";
import { loadConfig } from "./config.js";
import { getAvailableProviders } from "./providers/index.js";

export function createServer(): Server {
  const server = new Server(
    {
      name: "second-opinion",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const config = loadConfig();
    const providers = getAvailableProviders(config);
    const providerList = providers.length > 0 ? providers.join(", ") : "none configured";

    return {
      tools: [
        {
          name: "second_opinion",
          description: `Get an async code review from an external LLM. Available providers: ${providerList}.

This tool:
1. Reads context from your Claude Code session (files read/edited, conversation)
2. Analyzes dependencies, dependents, tests, and type definitions
3. Sends the bundled context to Gemini or GPT for review
4. Writes the review to a markdown file in your project

The reviewer sees the same context Claude had, plus related code for full understanding.`,
          inputSchema: {
            type: "object",
            properties: {
              provider: {
                type: "string",
                enum: ["gemini", "openai"],
                description: "Which LLM to use for the review",
              },
              projectPath: {
                type: "string",
                description: "Absolute path to the project being reviewed",
              },
              sessionId: {
                type: "string",
                description: "Claude Code session ID (defaults to most recent)",
              },
              includeConversation: {
                type: "boolean",
                default: true,
                description: "Include conversation context from Claude session",
              },
              includeDependencies: {
                type: "boolean",
                default: true,
                description: "Include files imported by modified files",
              },
              includeDependents: {
                type: "boolean",
                default: true,
                description: "Include files that import modified files",
              },
              includeTests: {
                type: "boolean",
                default: true,
                description: "Include corresponding test files",
              },
              includeTypes: {
                type: "boolean",
                default: true,
                description: "Include referenced type definitions",
              },
              maxTokens: {
                type: "number",
                default: 100000,
                description: "Maximum tokens for context",
              },
              sessionName: {
                type: "string",
                description: "Name for this review (used in output filename)",
              },
              customPrompt: {
                type: "string",
                description: "Additional instructions for the reviewer",
              },
              focusAreas: {
                type: "array",
                items: { type: "string" },
                description: "Specific areas to focus on",
              },
            },
            required: ["provider", "projectPath"],
          },
        },
      ],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "second_opinion") {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    try {
      // Validate input
      const input = SecondOpinionInputSchema.parse(request.params.arguments);

      // Execute the review
      const result = await executeReview(input);

      // Return success response
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                reviewFile: result.reviewFile,
                provider: result.provider,
                model: result.model,
                filesReviewed: result.filesReviewed,
                contextTokens: result.contextTokens,
                tokensUsed: result.tokensUsed,
                summary: result.review.substring(0, 500) + (result.review.length > 500 ? "..." : ""),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, error: message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

export async function runServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
