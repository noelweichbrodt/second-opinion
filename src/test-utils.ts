import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

/**
 * Create a temporary directory for tests
 */
export function createTempDir(prefix: string = "test"): string {
  const dir = path.join(os.tmpdir(), `second-opinion-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Clean up a temporary directory
 */
export function cleanupTempDir(dir: string): void {
  if (dir.startsWith(os.tmpdir())) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Create a project structure from a file tree specification
 *
 * @example
 * createProjectStructure(tmpDir, {
 *   "src/index.ts": "export const main = 1;",
 *   "src/utils/helper.ts": "export function helper() {}",
 *   "package.json": '{"name": "test"}'
 * });
 */
export function createProjectStructure(
  baseDir: string,
  files: Record<string, string>
): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(baseDir, relativePath);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content, "utf-8");
  }
}

/**
 * Session message for mock session data
 */
export interface MockSessionMessage {
  type: "user" | "assistant";
  content: string | object;
  timestamp?: string;
  toolUses?: MockToolUse[];
}

export interface MockToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface MockToolResult {
  tool_use_id: string;
  content: string;
}

/**
 * Create mock session JSONL data
 *
 * @example
 * const jsonl = createMockSession([
 *   { type: "user", content: "Help me with this code" },
 *   { type: "assistant", content: "I'll help you.", toolUses: [...] }
 * ]);
 */
export function createMockSession(messages: MockSessionMessage[]): string {
  const lines: string[] = [];
  const baseTime = Date.now();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const timestamp = msg.timestamp || new Date(baseTime + i * 1000).toISOString();

    if (msg.type === "user") {
      const entry = {
        type: "user",
        message: {
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        },
        timestamp,
      };
      lines.push(JSON.stringify(entry));
    } else {
      const contentBlocks: object[] = [];

      // Add text content if it's a string
      if (typeof msg.content === "string" && msg.content.length > 0) {
        contentBlocks.push({ type: "text", text: msg.content });
      }

      // Add tool uses if present
      if (msg.toolUses) {
        for (const toolUse of msg.toolUses) {
          contentBlocks.push({
            type: "tool_use",
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
          });
        }
      }

      const entry = {
        type: "assistant",
        message: {
          content: contentBlocks,
        },
        timestamp,
      };
      lines.push(JSON.stringify(entry));
    }
  }

  return lines.join("\n");
}

/**
 * Create a mock tool result entry
 */
export function createMockToolResult(toolUseId: string, content: string): string {
  const entry = {
    type: "tool_result",
    tool_use_id: toolUseId,
    content,
  };
  return JSON.stringify(entry);
}

/**
 * Create a sessions-index.json file
 */
export interface MockSessionIndexEntry {
  sessionId: string;
  firstPrompt?: string;
  projectPath?: string;
  modified?: string;
}

export function createMockSessionIndex(
  projectDir: string,
  entries: MockSessionIndexEntry[],
  originalPath?: string
): void {
  const index = {
    entries: entries.map((e) => ({
      sessionId: e.sessionId,
      fullPath: path.join(projectDir, `${e.sessionId}.jsonl`),
      firstPrompt: e.firstPrompt || "Test prompt",
      projectPath: e.projectPath,
      modified: e.modified || new Date().toISOString(),
    })),
    originalPath,
  };

  fs.writeFileSync(
    path.join(projectDir, "sessions-index.json"),
    JSON.stringify(index, null, 2)
  );
}

/**
 * Initialize a git repo in a directory (for git tests)
 * Uses execSync with static arguments - safe for test utilities
 */
export function initGitRepo(dir: string): void {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: dir, stdio: "pipe" });
}

/**
 * Make a git commit in a directory
 * Uses execSync with static arguments - safe for test utilities
 */
export function gitCommit(dir: string, message: string = "Initial commit"): void {
  execSync("git add -A", { cwd: dir, stdio: "pipe" });
  // Use array-based command to safely handle the message
  execSync(`git commit -m "${message.replace(/"/g, '\\"')}" --allow-empty`, { cwd: dir, stdio: "pipe" });
}
