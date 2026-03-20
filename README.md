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
│  5. Collect branch diff (feature branch vs base)                 │
│  6. Bundle within token budget                                   │
│  7. Send to Gemini + GPT (consensus mode)                        │
│  8. Write response to second-opinions/                           │
│                                                                  │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│          second-opinions/add-auth.consensus.review.md            │
│                                                                  │
│  # Consensus Code Review                                         │
│                                                                  │
│  ## Synthesis                                                    │
│  [Claude merges both perspectives with full context]             │
│                                                                  │
│  ## Gemini's Review                                              │
│  [BLOCKING] Missing rate limiting on login endpoint              │
│                                                                  │
│  ## OpenAI's Review                                              │
│  [SUGGESTION] Consider adding refresh token rotation             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Features

### Automatic Context Collection

Your session is the context. Second Opinion reads it automatically:

- **Session files** — Files you read, edited, or created
- **Conversation** — What you asked Claude to do
- **Dependencies** — Files imported by your modified code
- **Dependents** — Files that import your modified code
- **Tests** — Test files related to your changes
- **Types** — TypeScript/JSDoc type definitions
- **Pull request** — PR metadata, comments, reviews, and changed files (requires `gh` CLI)

### Custom Tasks

Don't just get code reviews—ask for anything:

```
/second-opinion Evaluate the error handling strategy across this codebase

/second-opinion Write user documentation for the API changes

/second-opinion openai Identify potential performance bottlenecks
```

### Consensus & Providers

By default, Second Opinion calls both Gemini and OpenAI in parallel. Claude then synthesizes the findings using its full session context—merging agreements, surfacing unique insights, and resolving disagreements.

```
/second-opinion                        # Consensus (default) — both providers
/second-opinion gemini Review this     # Gemini only
/second-opinion openai Review this     # GPT only
```

Consensus mode:
- Calls both providers simultaneously
- Claude synthesizes findings using the unified review framework
- **Smart fallback**: if only one API key is configured, uses that single provider

### Diff-Scoped Reviews

On feature branches, Second Opinion automatically includes the git diff (branch vs base). Reviewers distinguish issues introduced by your changes from pre-existing issues in the codebase:

- **Findings** — Issues in the diff (your changes)
- **Pre-existing Issues** — Legitimate issues NOT introduced by this change (lower priority)

### Smart Token Budgeting

Context is prioritized by category: explicitly included files first, then session files, git changes, dependencies, dependents, tests, and type definitions. Unused budget spills over to later categories. Files that don't fit are listed so you know what was omitted.

### Include Additional Files

Reference files outside your session:

```
/second-opinion The previous review at reviews/initial.md has been addressed. Verify the fixes.
```

## Examples

### Basic Code Review

```
> /second-opinion

Consensus review complete! Written to second-opinions/add-auth-flow.consensus.review.md
- Analyzed 14 files (52,000 tokens)
- Key findings: [BLOCKING] Missing input validation in login handler,
  [IMPORTANT] Consider rate limiting for auth endpoints
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

### Single Provider

When you want one model's perspective:

```
> /second-opinion gemini Review this implementation
> /second-opinion openai Review this implementation
```

### Configurable Temperature

Control creativity vs. focus:

```
> /second-opinion temp=0.8 Creative suggestions for improving UX
> /second-opinion temp=0.1 Strict security audit
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

### Secret Redaction

Second Opinion automatically scans file content for secrets before sending to external LLMs:

**Detected and redacted:**
- API keys (OpenAI `sk-...`, AWS `AKIA...`, GitHub `ghp_...`, Stripe `sk_live_...`)
- JWT tokens
- Database connection strings
- Private keys (PEM format)
- Generic secrets/passwords in assignment format
- Basic auth in URLs
- Slack tokens

Redacted content appears as `[REDACTED:type]` (e.g., `[REDACTED:api_key]`) in the output sent to the external LLM. The egress manifest records how many secrets were redacted and their types.

**Note:** This is a safety net, not a replacement for proper secret management. Sensitive paths like `.env` files are still blocked entirely.

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
| `GEMINI_MODEL` | `gemini-3-flash-preview` | Gemini model to use |
| `OPENAI_MODEL` | `gpt-5.2` | OpenAI model to use |
| `DEFAULT_PROVIDER` | `consensus` | Default provider (`gemini`, `openai`, or `consensus`) |
| `MAX_CONTEXT_TOKENS` | `200000` | Maximum tokens for context |
| `MAX_OUTPUT_TOKENS` | `32768` | Maximum tokens for reviewer's response |
| `TEMPERATURE` | `0.3` | Default LLM temperature (0-1) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (1 minute) |
| `RATE_LIMIT_MAX_REQUESTS` | `10` | Max requests per window |
| `REVIEWS_DIR` | `second-opinions` | Output directory (relative to project) |

### Config File

Create `~/.config/second-opinion/config.json`:

```json
{
  "geminiApiKey": "your-key",
  "openaiApiKey": "your-key",
  "defaultProvider": "consensus",
  "geminiModel": "gemini-3-flash-preview",
  "openaiModel": "gpt-5.2",
  "maxContextTokens": 200000,
  "maxOutputTokens": 32768,
  "temperature": 0.3,
  "rateLimitWindowMs": 60000,
  "rateLimitMaxRequests": 10,
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
| `provider` | Yes | — | `"gemini"`, `"openai"`, or `"consensus"` (falls back to single provider if only one key configured) |
| `projectPath` | Yes | — | Absolute path to project |
| `task` | No | — | Custom prompt (defaults to code review) |
| `sessionId` | No | latest | Claude Code session ID |
| `sessionName` | No | auto | Name for output file |
| `includeFiles` | No | — | Additional files/folders to include |
| `allowExternalFiles` | No | `false` | Allow files outside project |
| `dryRun` | No | `false` | Preview without calling external API |
| `includeConversation` | No | `true` | Include conversation context |
| `includeDependencies` | No | `true` | Include imported files |
| `includeDependents` | No | `true` | Include importing files |
| `includeTests` | No | `true` | Include test files |
| `includeTypes` | No | `true` | Include type definitions |
| `maxInputTokens` | No | `200000` | Context token budget |
| `maxOutputTokens` | No | `32768` | Max tokens for reviewer's response |
| `temperature` | No | `0.3` | LLM temperature (0-1) |
| `focusAreas` | No | — | Specific areas to focus on |

## Requirements

- Node.js 18+
- Claude Code CLI
- At least one API key (Gemini or OpenAI)
- [GitHub CLI (`gh`)](https://cli.github.com/) — optional, required for PR context detection

## License

MIT
