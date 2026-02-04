# Second Opinion - Get Another LLM's Perspective

This project provides an MCP server that enables getting a second opinion from Gemini or GPT while working in Claude Code.

## /second-opinion Skill

When the user invokes `/second-opinion`, help them get feedback from an external LLM.

### How It Works

1. **Context Collection**: The MCP tool reads:
   - Files you read/edited in the current Claude Code session
   - The conversation context (what the user asked for)
   - Dependencies (files imported by modified code)
   - Dependents (files that import modified code)
   - Related test files
   - Type definitions

2. **Task Execution**: Sends the bundled context to Gemini or GPT with either:
   - A custom task/prompt provided by the user
   - Default code review behavior (when no task specified)

3. **Output**: Writes the response to `second-opinions/[session-name].[provider].[task].md`

### Usage

**Default (code review):**
```
/second-opinion
```

**With custom task:**
```
/second-opinion Evaluate this codebase for unnecessary complexity. Consider how to simplify, DRY, and ensure there are no code smells or overly elaborate structures.
```

**With provider:**
```
/second-opinion openai Check for security vulnerabilities in the authentication flow.
```

When the user invokes the skill:

1. Parse the input:
   - First word may be provider (`gemini` or `openai`)
   - Remaining text is the task (if any)
   - If no provider specified, use default (gemini)

2. Derive a session name from the work done (e.g., "add-user-auth", "fix-login-bug")

3. Call the `second_opinion` MCP tool:

```json
{
  "provider": "gemini",
  "projectPath": "/absolute/path/to/project",
  "sessionName": "descriptive-session-name",
  "task": "Evaluate this codebase for unnecessary complexity..."
}
```

4. Report the results:
   - Path to the output file
   - Number of files analyzed
   - Brief summary of key findings

### Examples

**Default code review:**
```
User: /second-opinion

Claude: I'll get a code review from Gemini.
[Calls second_opinion tool]
Claude: Review complete! Written to second-opinions/add-user-auth.gemini.review.md
- Analyzed 12 files
- Key findings: [brief summary]
```

**Custom task:**
```
User: /second-opinion Evaluate the error handling strategy. Are errors handled consistently? Are there gaps?

Claude: I'll ask Gemini to evaluate the error handling strategy.
[Calls second_opinion tool with task]
Claude: Analysis complete! Written to second-opinions/add-user-auth.gemini.evaluate-error-handling.md
```

**With specific provider:**
```
User: /second-opinion openai Write documentation for the changes made in this session.

Claude: I'll ask GPT to write documentation.
[Calls second_opinion tool with provider: "openai", task: "Write documentation..."]
```

**With additional files:**
```
User: /second-opinion The previous review at ~/project/reviews/initial.review.md has been addressed. Evaluate the changes.

Claude: I'll include the previous review and ask Gemini to evaluate the changes.
[Calls second_opinion tool with includeFiles: ["~/project/reviews/initial.review.md"], task: "The previous review..."]
```

### Tool Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| provider | Yes | - | "gemini" or "openai" |
| projectPath | Yes | - | Absolute path to project |
| task | No | - | Custom task/prompt for the LLM (defaults to code review) |
| sessionId | No | latest | Claude Code session ID |
| sessionName | No | auto | Name for output file |
| includeFiles | No | - | Additional files/folders to include (supports ~ and relative paths) |
| includeConversation | No | true | Include chat context |
| includeDependencies | No | true | Include imported files |
| includeDependents | No | true | Include importing files |
| includeTests | No | true | Include test files |
| includeTypes | No | true | Include type definitions |
| maxTokens | No | 100000 | Context token budget |
| focusAreas | No | - | Areas to focus on (for code reviews) |

## Setup

1. Install and build:
```bash
cd second-opinion
npm install
npm run build
```

2. Add to Claude Code:
```bash
claude mcp add second-opinion -- node /path/to/second-opinion/dist/index.js
```

3. Set API keys (at least one):
```bash
export GEMINI_API_KEY=your-key    # For Gemini
export OPENAI_API_KEY=your-key    # For GPT
```

**Security Note:** Avoid pasting API keys directly in the terminal as they may be saved in shell history. Safer alternatives:

```bash
# Read from a secure file (recommended)
export GEMINI_API_KEY=$(cat ~/.secrets/google-api-key)

# Or use a password manager CLI
export OPENAI_API_KEY=$(op read "op://Private/OpenAI/api-key")

# Or set in the MCP config with file expansion
claude mcp add second-opinion \
  -e GEMINI_API_KEY="$(cat ~/.secrets/google-api-key)" \
  -- node /path/to/second-opinion/dist/index.js
```

4. Optional: Configure models via environment variables:
```bash
export GEMINI_MODEL=gemini-2.0-flash-exp  # Default
export OPENAI_MODEL=gpt-4o                 # Default
```

5. Optional: Create global review instructions at `~/.config/second-opinion/second-opinion.md`

## Configuration

All settings can be configured via environment variables (set with `-e` when adding the MCP server) or in `~/.config/second-opinion/config.json`.

| Variable | Default | Description |
|----------|---------|-------------|
| GEMINI_API_KEY | - | API key for Gemini |
| OPENAI_API_KEY | - | API key for OpenAI |
| GEMINI_MODEL | gemini-2.0-flash-exp | Gemini model to use |
| OPENAI_MODEL | gpt-4o | OpenAI model to use |
| DEFAULT_PROVIDER | gemini | Default provider if not specified |
| MAX_CONTEXT_TOKENS | 100000 | Token budget for context |
| REVIEWS_DIR | second-opinions | Output directory for responses |

Example with custom model:
```bash
claude mcp add second-opinion \
  -e OPENAI_API_KEY='your-key' \
  -e OPENAI_MODEL='gpt-4-turbo' \
  -- node /path/to/second-opinion/dist/index.js
```
