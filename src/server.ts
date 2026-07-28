import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  SecondOpinionInputSchema,
  executeReview,
  EgressSummary,
} from "./tools/review.js";
import { loadConfig } from "./config.js";
import { getAvailableProviders } from "./providers/index.js";

/**
 * The wire inputSchema is derived from the zod schema so validation and the
 * advertised contract cannot drift. This definition rides in every MCP
 * session's context — keep it lean.
 */
export function buildToolInputSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(SecondOpinionInputSchema, {
    $refStrategy: "none",
  }) as Record<string, unknown>;
  // Converter metadata the MCP wire contract doesn't need. (Zod strips
  // unknown keys rather than rejecting them, so additionalProperties:false
  // would also misstate the validator's behavior.)
  delete schema.$schema;
  delete schema.additionalProperties;
  return schema;
}

/**
 * Compact egress echo for non-dry-run responses. The full path lists live in
 * the egress manifest file; re-serializing them into every tool result cost
 * ~2k tokens per call. Dry runs keep the complete detail — that preview is
 * the user-consent surface.
 */
function leanEgress(summary: EgressSummary) {
  return {
    provider: summary.provider,
    projectFilesSent: summary.projectFilesSent,
    externalFilesSent: summary.externalFilesSent,
    blockedFiles: summary.blockedFiles.length,
    redactions: summary.redactions?.totalCount ?? 0,
    prNumber: summary.prContext?.prNumber,
  };
}

/** Non-dry-run responses are serialized compactly; dry runs stay pretty. */
function textResult(payload: unknown, pretty = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, pretty ? 2 : undefined),
      },
    ],
  };
}

/**
 * Budget reductions the caller must be able to act on ("raise
 * maxInputTokens") — message strings only, and only when present, so the
 * lean-response goal (I1) is preserved.
 */
function leanWarnings(warnings: { message: string }[]): string[] | undefined {
  return warnings.length > 0 ? warnings.map((w) => w.message) : undefined;
}

export function createServer(): Server {
  const server = new Server(
    {
      name: "second-opinion",
      version: "0.7.0",
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
          description:
            `External review from Gemini (in-process), Codex (a /codex:rescue handoff), or both (consensus). Available: ${providerList}. ` +
            "Bundles session context and related code; writes the review file and egress manifest. " +
            "Complete codex/consensus handoffs per the /second-opinion skill.",
          inputSchema: buildToolInputSchema(),
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

      // Dry run keeps full egress detail (paths, blocked files, warnings):
      // it is the confirmation surface before content leaves the machine.
      if (result.dryRun) {
        return textResult(
          {
            dryRun: true,
            provider: result.provider,
            summary: result.summary,
            totalTokens: result.totalTokens,
            budgetWarnings: result.budgetWarnings,
            message: result.message,
            prDetectionFailure: result.prDetectionFailure,
          },
          true
        );
      }

      if (result.handoff) {
        return textResult({
          handoff: true,
          provider: result.provider,
          model: result.model,
          promptFile: result.promptFile,
          reviewFile: result.reviewFile,
          egressManifestFile: result.egressManifestFile,
          rescueCommand: result.rescueCommand,
          verifyCommand: result.verifyCommand,
          spliceCommand: result.spliceCommand,
          filesReviewed: result.filesReviewed,
          contextTokens: result.contextTokens,
          egress: leanEgress(result.summary),
          budgetWarnings: leanWarnings(result.budgetWarnings),
          // Status only — the full Gemini review is already in reviewFile,
          // which Claude reads once for synthesis. A preview here would be
          // paid for and then discarded.
          gemini: result.gemini && {
            model: result.gemini.model,
            tokensUsed: result.gemini.tokensUsed,
            error: result.gemini.error,
          },
          prDetectionFailure: result.prDetectionFailure,
        });
      }

      // Return success response for actual review
      return textResult({
        success: true,
        reviewFile: result.reviewFile,
        egressManifestFile: result.egressManifestFile,
        provider: result.provider,
        model: result.model,
        filesReviewed: result.filesReviewed,
        contextTokens: result.contextTokens,
        tokensUsed: result.tokensUsed,
        egress: leanEgress(result.summary),
        budgetWarnings: leanWarnings(result.budgetWarnings),
        prDetectionFailure: result.prDetectionFailure,
        reviewPreview: result.review.substring(0, 500) + (result.review.length > 500 ? "..." : ""),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, error: message }),
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
