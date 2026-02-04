# Second Opinion

Get code reviews and feedback from Gemini or GPT while working in Claude Code.

Second Opinion is an MCP server that automatically collects context from your Claude Code session—files you've read, edited, and their dependencies—and sends it to another LLM for review. No copy-pasting, no context switching.

## Quick Start

```bash
# Add to Claude Code (one command)
claude mcp add second-opinion \
  -e GEMINI_API_KEY="$(cat ~/.secrets/gemini-key)" \
  -- npx second-opinion-mcp
```

Then in Claude Code:

```
/second-opinion
```

That's it. The review appears in `second-opinions/`.

## Features

### Automatic Context Collection

Second Opinion reads your Claude Code session to understand what you're working on:

- **Session files** — Files you read, edited, or created
- **Conversation** — What you asked Claude to do (code blocks stripped to avoid stale references)
- **Dependencies** — Files imported by your modified code
- **Dependents** — Files that import your modified code
- **Tests** — Test files related to your changes
- **Types** — TypeScript/JSDoc type definitions

### Custom Tasks

Don't just get code reviews—ask for anything:

```
/second-opinion Evaluate the error handling strategy across this codebase

/second-opinion Write user documentation for the API changes

/second-opinion openai Identify potential performance bottlenecks
```

### Multiple Providers

Switch between Gemini and GPT:

```
/second-opinion gemini Review this code    # Uses Gemini (default)
/second-opinion openai Review this code    # Uses GPT
```

### Smart Token Budgeting

Context is prioritized to fit within token limits:

1. Explicitly included files (highest priority)
2. Session files (what you worked on)
3. Git changes
4. Dependencies
5. Dependents
6. Tests
7. Type definitions

Files that don't fit are listed in the output so you know what was omitted.

### Include Additional Files

Reference files outside your session:

```
/second-opinion The previous review at reviews/initial.md has been addressed. Verify the fixes.
```

## Examples

### Basic Code Review

```
> /second-opinion

Review complete! Written to second-opinions/add-auth-flow.gemini.review.md
- Analyzed 14 files (52,000 tokens)
- Key findings: Missing input validation in login handler,
  consider rate limiting for auth endpoints
```

### Security Audit

```
> /second-opinion openai Audit this code for security vulnerabilities.
  Focus on authentication, input validation, and data exposure.

Analysis complete! Written to second-opinions/add-auth-flow.openai.security-audit.md
```

### Architecture Review

```
> /second-opinion Evaluate the architecture of this feature.
  Is the separation of concerns appropriate? Are there any circular dependencies?
```

### Documentation Generation

```
> /second-opinion Write API documentation for the changes made in this session.
  Include request/response examples.
```

### Compare Perspectives

Get reviews from both providers:

```
> /second-opinion gemini Review this implementation
> /second-opinion openai Review this implementation
```

## Security

Second Opinion implements multiple layers of protection:

### What Data Is Sent

When you use Second Opinion, the following data may be sent to the external LLM (Gemini or OpenAI):

- **File contents**: Source code from your project and any explicitly included files
- **Conversation context**: A summary of your Claude Code session (what you asked, not your full chat history)
- **File metadata**: File paths relative to your project

The tool does NOT send:
- Your API keys
- System files or shell history
- Files blocked by sensitive path patterns

### Sensitive Path Blocking

The following paths are always blocked, even when explicitly requested:

- SSH keys and config (`~/.ssh/`)
- AWS credentials (`~/.aws/`)
- GPG keys (`~/.gnupg/`)
- Cloud configs (`~/.config/gcloud/`, `~/.kube/`)
- Git internals (`/.git/`)
- Auth files (`.netrc`, `.npmrc`, `.pypirc`)
- Private keys (`*.pem`, `*.key`, `id_rsa`, `id_ed25519`)
- Service account credentials
- Environment files (`.env`, `.env.local`, `.env.production`)
- Terraform secrets (`.tfvars`, `terraform.tfstate`)
- Kubernetes secrets (`secret.yaml`, `secret.yml`)
- Shell history (`.bash_history`, `.zsh_history`)

### External File Protection

By default, files outside your project directory are blocked. If you need to include external files, you must explicitly set `allowExternalFiles: true`. This prevents accidental exfiltration of files from other projects or system locations.

### Symlink Protection

All paths are resolved via `realpathSync()` before reading. A symlink pointing to `~/.ssh/id_rsa` will be blocked even if it lives inside your project.

### Output Directory Validation

Reviews are only written within your project directory. Path traversal attempts (e.g., `../../../etc/passwd`) are rejected.

### Egress Audit Trail

Every review creates a companion `.egress.json` file that records:
- Exactly which files were sent to the external LLM
- Which files were blocked and why
- Timestamp and provider information

This allows you to audit what data left your system.

### API Key Safety

Never paste API keys directly in the terminal—they get saved to shell history. Instead:

```bash
# Read from a file
export GEMINI_API_KEY=$(cat ~/.secrets/gemini-key)

# Use a password manager
export OPENAI_API_KEY=$(op read "op://Private/OpenAI/api-key")

# Set via MCP config
claude mcp add second-opinion \
  -e GEMINI_API_KEY="$(cat ~/.secrets/gemini-key)" \
  -- npx second-opinion-mcp
```

**Never paste API keys directly in Claude Code chat.** Keys in chat messages could be logged or sent to external providers.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | — | API key for Google Gemini |
| `OPENAI_API_KEY` | — | API key for OpenAI |
| `GEMINI_MODEL` | `gemini-2.0-flash-exp` | Gemini model to use |
| `OPENAI_MODEL` | `gpt-4o` | OpenAI model to use |
| `DEFAULT_PROVIDER` | `gemini` | Default provider when not specified |
| `MAX_CONTEXT_TOKENS` | `100000` | Maximum tokens for context |
| `REVIEWS_DIR` | `second-opinions` | Output directory (relative to project) |

### Config File

Create `~/.config/second-opinion/config.json`:

```json
{
  "geminiApiKey": "your-key",
  "openaiApiKey": "your-key",
  "defaultProvider": "gemini",
  "geminiModel": "gemini-2.0-flash-exp",
  "openaiModel": "gpt-4o",
  "maxContextTokens": 100000,
  "reviewsDir": "second-opinions"
}
```

Environment variables take precedence over the config file.

### Custom Review Instructions

Create `~/.config/second-opinion/second-opinion.md` for global instructions, or `second-opinion.md` in your project root for project-specific instructions:

```markdown
# Review Instructions

Focus on:
- Security vulnerabilities (OWASP Top 10)
- Performance implications
- Error handling completeness
- Test coverage gaps

Our stack: TypeScript, React, PostgreSQL
Coding standards: Airbnb style guide
```

## Tool Parameters

When calling the MCP tool directly:

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `provider` | Yes | — | `"gemini"` or `"openai"` |
| `projectPath` | Yes | — | Absolute path to project |
| `task` | No | — | Custom prompt (defaults to code review) |
| `sessionId` | No | latest | Claude Code session ID |
| `sessionName` | No | auto | Name for output file |
| `includeFiles` | No | — | Additional files/folders to include |
| `allowExternalFiles` | No | `false` | Allow files outside project (required for external paths in includeFiles) |
| `dryRun` | No | `false` | Preview what would be sent without calling external API |
| `includeConversation` | No | `true` | Include conversation context |
| `includeDependencies` | No | `true` | Include imported files |
| `includeDependents` | No | `true` | Include importing files |
| `includeTests` | No | `true` | Include test files |
| `includeTypes` | No | `true` | Include type definitions |
| `maxTokens` | No | `100000` | Context token budget |
| `focusAreas` | No | — | Specific areas to focus on |

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                        Claude Code                               │
│                                                                  │
│  You: "Add user authentication"                                  │
│  Claude: [reads files, writes code, runs tests]                  │
│  You: "/second-opinion"                                          │
│                                                                  │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Second Opinion MCP                            │
│                                                                  │
│  1. Parse Claude Code session logs                               │
│  2. Collect files read/written + their content                   │
│  3. Resolve dependencies and dependents                          │
│  4. Find related tests and types                                 │
│  5. Bundle within token budget                                   │
│  6. Send to Gemini/GPT                                           │
│  7. Write response to second-opinions/                           │
│                                                                  │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│              second-opinions/add-auth.gemini.review.md           │
│                                                                  │
│  # Code Review - add-auth                                        │
│  **Provider:** gemini                                            │
│                                                                  │
│  ## Summary                                                      │
│  The authentication implementation is solid...                   │
│                                                                  │
│  ## Critical Issues                                              │
│  - Missing rate limiting on login endpoint                       │
│                                                                  │
│  ## Suggestions                                                  │
│  - Consider adding refresh token rotation                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Requirements

- Node.js 18+
- Claude Code CLI
- At least one API key (Gemini or OpenAI)

## License

MIT
