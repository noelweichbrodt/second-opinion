import * as fs from "fs";
import * as path from "path";
import { getClaudeProjectsDir } from "../config.js";

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface FileOperation {
  type: "read" | "write" | "edit";
  filePath: string;
  content?: string;
}

export interface SessionContext {
  sessionId: string;
  projectPath: string;
  filesRead: string[];
  filesWritten: string[];
  filesEdited: string[];
  fileContents: Map<string, string>;
  conversation: SessionMessage[];
}

interface SessionIndexEntry {
  sessionId: string;
  fullPath: string;
  firstPrompt: string;
  projectPath: string;
  modified: string;
}

interface SessionIndex {
  entries: SessionIndexEntry[];
  originalPath: string;
}

/**
 * Convert a project path to the Claude projects directory name format
 * e.g., /Users/noel/w/my-project -> -Users-noel-w-my-project
 */
function projectPathToDir(projectPath: string): string {
  return projectPath.replace(/\//g, "-");
}

/**
 * Resolve persisted content from tool results
 * When tool output is too large, Claude Code saves it to a file and includes a marker
 */
function resolvePersistedContent(
  content: string,
  projectDir: string
): string {
  // Check for the persisted-output marker
  const persistedMatch = content.match(
    /<persisted-output>[\s\S]*?Full output saved to:\s*([^\s<]+)/
  );
  if (!persistedMatch) {
    return content;
  }

  const savedPath = persistedMatch[1];

  // Try reading the full content from the saved file
  // The path might be relative to the project dir or absolute
  const candidates = [
    savedPath,
    path.join(projectDir, savedPath),
    path.join(projectDir, "tool-results", path.basename(savedPath)),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, "utf-8");
      }
    } catch {
      // Continue to next candidate
    }
  }

  // Couldn't find the persisted file, return original content
  return content;
}

/**
 * Find the project directory by scanning all sessions-index.json files
 * and matching by originalPath or projectPath fields
 */
function findProjectDir(projectPath: string): string | null {
  const projectsDir = getClaudeProjectsDir();

  // Normalize the project path for comparison
  const normalizedProjectPath = path.normalize(projectPath);

  // First, try the direct mapping (fallback)
  const directDir = path.join(projectsDir, projectPathToDir(projectPath));
  if (fs.existsSync(path.join(directDir, "sessions-index.json"))) {
    return directDir;
  }

  // Scan all subdirectories in the projects dir
  try {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const indexPath = path.join(projectsDir, entry.name, "sessions-index.json");
      if (!fs.existsSync(indexPath)) continue;

      try {
        const index: SessionIndex = JSON.parse(
          fs.readFileSync(indexPath, "utf-8")
        );

        // Check originalPath field
        if (index.originalPath) {
          const normalizedOriginal = path.normalize(index.originalPath);
          if (normalizedOriginal === normalizedProjectPath) {
            return path.join(projectsDir, entry.name);
          }
        }

        // Check projectPath in entries
        for (const session of index.entries) {
          if (session.projectPath) {
            const normalizedEntry = path.normalize(session.projectPath);
            if (normalizedEntry === normalizedProjectPath) {
              return path.join(projectsDir, entry.name);
            }
          }
        }
      } catch {
        // Skip malformed index files
      }
    }
  } catch {
    // If we can't read the projects dir, fall back to direct mapping
  }

  return null;
}

/**
 * Find the most recent session for a project
 */
export function findLatestSession(projectPath: string): string | null {
  const projectDir = findProjectDir(projectPath);
  if (!projectDir) {
    return null;
  }

  const indexPath = path.join(projectDir, "sessions-index.json");
  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const index: SessionIndex = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    if (index.entries.length === 0) {
      return null;
    }

    // Sort by modified date, most recent first
    const sorted = [...index.entries].sort(
      (a, b) =>
        new Date(b.modified).getTime() - new Date(a.modified).getTime()
    );

    return sorted[0].sessionId;
  } catch {
    return null;
  }
}

/**
 * Get the path to a session's JSONL file
 */
export function getSessionPath(
  projectPath: string,
  sessionId: string
): string | null {
  const projectDir = findProjectDir(projectPath);
  if (!projectDir) {
    return null;
  }

  const sessionPath = path.join(projectDir, `${sessionId}.jsonl`);

  if (fs.existsSync(sessionPath)) {
    return sessionPath;
  }

  return null;
}

/**
 * Parse a session JSONL file and extract context
 */
export function parseSession(
  projectPath: string,
  sessionId: string
): SessionContext | null {
  const sessionPath = getSessionPath(projectPath, sessionId);
  if (!sessionPath) {
    return null;
  }

  // Get the project directory for resolving persisted content
  const projectDir = path.dirname(sessionPath);

  const context: SessionContext = {
    sessionId,
    projectPath,
    filesRead: [],
    filesWritten: [],
    filesEdited: [],
    fileContents: new Map(),
    conversation: [],
  };

  const fileReadSet = new Set<string>();
  const fileWrittenSet = new Set<string>();
  const fileEditedSet = new Set<string>();

  // Track tool_use IDs to match with results
  const pendingToolUses = new Map<
    string,
    { type: "read" | "write" | "edit"; filePath: string }
  >();

  const lines = fs.readFileSync(sessionPath, "utf-8").split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line);

      // Extract user messages
      if (entry.type === "user" && entry.message?.content) {
        const content =
          typeof entry.message.content === "string"
            ? entry.message.content
            : JSON.stringify(entry.message.content);

        // Skip system/meta messages
        if (
          !content.startsWith("<local-command") &&
          !content.startsWith("<command-")
        ) {
          context.conversation.push({
            role: "user",
            content: content,
            timestamp: entry.timestamp,
          });
        }
      }

      // Extract assistant messages
      if (entry.type === "assistant" && entry.message?.content) {
        const contents = Array.isArray(entry.message.content)
          ? entry.message.content
          : [entry.message.content];

        for (const block of contents) {
          // Text responses
          if (block.type === "text" && block.text) {
            // Skip API errors
            if (!block.text.startsWith("API Error:")) {
              context.conversation.push({
                role: "assistant",
                content: block.text,
                timestamp: entry.timestamp,
              });
            }
          }

          // Tool uses - track file operations
          if (block.type === "tool_use") {
            const toolName = block.name;
            const input = block.input || {};
            const toolId = block.id;

            if (toolName === "Read" && input.file_path) {
              fileReadSet.add(input.file_path);
              pendingToolUses.set(toolId, {
                type: "read",
                filePath: input.file_path,
              });
            } else if (toolName === "Write" && input.file_path) {
              fileWrittenSet.add(input.file_path);
              if (input.content) {
                context.fileContents.set(input.file_path, input.content);
              }
            } else if (toolName === "Edit" && input.file_path) {
              fileEditedSet.add(input.file_path);
            }
          }

          // Tool results - capture file contents from Read operations
          if (block.type === "tool_result" && block.tool_use_id) {
            const pending = pendingToolUses.get(block.tool_use_id);
            if (pending && pending.type === "read" && block.content) {
              // Resolve persisted content if the result was saved to a file
              const resolvedContent = resolvePersistedContent(
                block.content,
                projectDir
              );
              // Store the content Claude saw
              context.fileContents.set(pending.filePath, resolvedContent);
              pendingToolUses.delete(block.tool_use_id);
            }
          }
        }
      }

      // Also check for tool_result in the message content directly
      if (entry.message?.content) {
        const contents = Array.isArray(entry.message.content)
          ? entry.message.content
          : [];

        for (const block of contents) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const pending = pendingToolUses.get(block.tool_use_id);
            if (pending && pending.type === "read" && block.content) {
              // Resolve persisted content if the result was saved to a file
              const resolvedContent = resolvePersistedContent(
                block.content,
                projectDir
              );
              context.fileContents.set(pending.filePath, resolvedContent);
              pendingToolUses.delete(block.tool_use_id);
            }
          }
        }
      }

      // Handle top-level tool_result entries (some Claude Code versions use this format)
      if (entry.type === "tool_result" && entry.tool_use_id) {
        const pending = pendingToolUses.get(entry.tool_use_id);
        if (pending && pending.type === "read" && entry.content) {
          const content =
            typeof entry.content === "string"
              ? entry.content
              : JSON.stringify(entry.content);
          const resolvedContent = resolvePersistedContent(content, projectDir);
          context.fileContents.set(pending.filePath, resolvedContent);
          pendingToolUses.delete(entry.tool_use_id);
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  context.filesRead = Array.from(fileReadSet);
  context.filesWritten = Array.from(fileWrittenSet);
  context.filesEdited = Array.from(fileEditedSet);

  return context;
}

/**
 * Remove or condense code blocks from a message to avoid stale code in conversation
 * The Files section contains current code, so we don't need it duplicated here
 */
function condenseCodeBlocks(content: string): string {
  // Match fenced code blocks (```...```)
  const codeBlockRegex = /```[\s\S]*?```/g;

  // Count code blocks and their total size
  const codeBlocks = content.match(codeBlockRegex) || [];
  const codeSize = codeBlocks.reduce((sum, block) => sum + block.length, 0);

  // If more than 50% of the message is code, it's primarily a code dump
  if (codeSize > content.length * 0.5 && codeSize > 500) {
    // Replace code blocks with placeholder
    return content.replace(
      codeBlockRegex,
      "\n[code snippet omitted - see Files section for current code]\n"
    );
  }

  // For smaller code blocks, keep them but truncate if very long
  return content.replace(codeBlockRegex, (block) => {
    if (block.length > 500) {
      const lines = block.split("\n");
      const lang = lines[0]; // ```language
      const preview = lines.slice(1, 6).join("\n"); // First few lines
      return `${lang}\n${preview}\n... [truncated - see Files section]\n\`\`\``;
    }
    return block;
  });
}

/**
 * Format session context as markdown for the reviewer
 */
export function formatConversationContext(context: SessionContext): string {
  if (context.conversation.length === 0) {
    return "";
  }

  let output = "## Conversation Context\n\n";
  output +=
    "This is the conversation between the user and Claude that led to these changes.\n";
  output +=
    "*Note: Code snippets in conversation may be outdated. See the Files section for current code.*\n\n";

  for (const msg of context.conversation) {
    const role = msg.role === "user" ? "**User**" : "**Claude**";

    // Condense code blocks to avoid stale code confusion
    let content = condenseCodeBlocks(msg.content);

    // Truncate very long messages
    if (content.length > 2000) {
      content = content.substring(0, 2000) + "\n...(truncated)";
    }

    output += `${role}:\n${content}\n\n`;
  }

  return output;
}
