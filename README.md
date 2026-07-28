# Second Opinion

Get code reviews and feedback from Gemini and Codex while working in Claude Code.

Second Opinion is an MCP server plus a Claude Code skill. It collects the files, conversation context, dependencies, tests, types, and branch diff relevant to your current work. Gemini reviews that bundle through its API. Codex reviews it through a local handoff: the tool exports a self-contained prompt, and the skill runs the OpenAI Codex Claude Code plugin using your ChatGPT-plan authentication.

The MCP server does not call the OpenAI API and does not require an OpenAI API key.

## Requirements

- Node.js 18+
- Claude Code CLI
- Codex CLI, authenticated with a ChatGPT plan (`codex login`)
- The `openai-codex` Claude Code plugin, which provides `/codex:rescue`
- `GEMINI_API_KEY` only if you want Gemini or full consensus mode
- [GitHub CLI (`gh`)](https://cli.github.com/) — optional, for pull-request context detection

## Quick Start

Install and authenticate Codex:

```bash
npm install -g @openai/codex
codex login
```

In Claude Code, install the OpenAI Codex plugin:

```text
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/reload-plugins
/codex:setup
```

Add Second Opinion. Codex-only use needs no API key:

```bash
claude mcp add second-opinion -- npx second-opinion-mcp
```

To enable Gemini and full consensus mode:

```bash
claude mcp add second-opinion \
  -e GEMINI_API_KEY="$(cat ~/.secrets/gemini-key)" \
  -- npx second-opinion-mcp
```

Then run this in Claude Code:

```text
/second-opinion
```

The completed review appears in `second-opinions/`.

## Providers

| Provider | Behavior | Authentication |
|----------|----------|----------------|
| `codex` | Exports a prompt and returns a `/codex:rescue` handoff for the skill to complete | Local Codex CLI authenticated with `codex login` and a ChatGPT plan |
| `gemini` | Calls Gemini in-process and writes the completed review | `GEMINI_API_KEY` |
| `consensus` | Gets Gemini's review, prepares the Codex handoff, then has Claude synthesize both | Gemini key plus Codex CLI; without a Gemini key, degrades to Codex-only |
| `openai` | Deprecated input alias that normalizes to `codex` | Same as `codex`; no OpenAI API call |

The default provider is `consensus`.

## How the Codex Handoff Works

Codex reviews are deliberately orchestrated at the skill layer so long, ultra-effort runs are not constrained by an MCP tool-call timeout:

1. The `second_opinion` tool collects and redacts context.
2. It writes a self-contained `*.prompt.md`, a review file containing a clearly marked placeholder, and an `.egress.json` audit manifest.
3. It returns a handoff descriptor containing `promptFile`, `reviewFile`, `egressManifestFile`, `model`, and `rescueCommand`.
4. The `/second-opinion` skill invokes the returned `/codex:rescue` command. Before the task text, it inserts `--wait` for a small bundle, or `--background` for a large bundle and follows it with `/codex:status` and `/codex:result`.
5. The skill pastes Codex's final message verbatim into `reviewFile`, replacing the Codex placeholder.
6. In consensus mode, the file already contains Gemini's review. After inserting Codex's review, Claude replaces the `## Synthesis` placeholder with a unified assessment.

A returned command has this form:

```text
/codex:rescue --model gpt-5.6-sol --fresh Read the complete review prompt at /absolute/path/to/review.prompt.md. Follow every instruction in it. Produce the full review markdown as your final message. This is a read-only task; modify no files.
```

Do not add `--effort`. Reasoning effort is intentionally not configurable by Second Opinion. Omitting the flag inherits `model_reasoning_effort = "ultra"` from `~/.codex/config.toml`; the explicit values accepted by the plugin top out at `xhigh` and would downgrade the review.

The tool never asks Codex to edit the project. The exported prompt explicitly makes the run read-only and asks for the complete review Markdown as the final message.

## Usage

```text
/second-opinion                                  # Consensus (default)
/second-opinion codex Review this                # Codex handoff only
/second-opinion gemini Review this               # Gemini API only
/second-opinion consensus Security audit this    # Gemini + Codex + synthesis
/second-opinion openai Review this               # Deprecated alias for codex
```

Custom text normally augments the standard review methodology:

```text
/second-opinion Evaluate error handling consistency and find swallowed errors
```

For a genuinely different deliverable, the skill sends the text as a replacement task. Task prompts are self-contained: the code-review methodology and language checklists are not sent with them:

```text
/second-opinion codex Write a migration guide for the changes in this session
```

You can also include another file:

```text
/second-opinion The previous review at reviews/initial.md has been addressed. Verify the fixes.
```

### Consensus Mode

With a Gemini key configured, one tool call gets Gemini's review in-process and prepares the Codex handoff. The skill completes Codex's run, inserts the result verbatim, and writes the synthesis using its richer conversation context.

The synthesis:

- merges and deduplicates findings;
- notes agreement, disagreement, and reviewer provenance;
- preserves severity labels and evidence requirements;
- separates diff-introduced findings from pre-existing issues;
- resolves defensive recommendations at the highest useful architectural boundary; and
- combines questions, upstream/downstream opportunities, and praise.

Without `GEMINI_API_KEY`, consensus degrades to a Codex-only handoff.

### Temperature

Temperature is a Gemini-only setting. It is ignored by `codex`; in `consensus` it affects only the Gemini call.

```text
/second-opinion gemini temp=0.8 Explore alternative designs
/second-opinion consensus temp=0.1 Perform a strict security audit
```

Codex reasoning quality is controlled by the handoff's model and the inherited ultra reasoning effort, not temperature.

## Context Collection

Your session supplies the context:

- **Session files** — files read, edited, or created
- **Conversation** — what you asked Claude to do
- **Dependencies** — files imported by modified code
- **Dependents** — files that import modified code
- **Tests** — related test files
- **Types** — TypeScript/JSDoc type definitions
- **Branch diff** — feature branch versus its base
- **Pull request** — PR metadata, comments, reviews, and changed files when `gh` is available

Context is prioritized by category and fitted into the token budget. Explicitly included files come first, followed by session files, git changes, dependencies, dependents, tests, and types. The dry-run result and completed egress manifest show what was included, omitted, or blocked.

## Security

### What Leaves the Project

For Gemini, the MCP server sends the redacted bundle to the Gemini API. For Codex, the MCP server writes the redacted bundle into the local prompt file; the Codex CLI then reads it and sends the review request using its own ChatGPT-plan authentication.

The bundle may contain:

- source files from the project and any explicitly approved external files;
- the session conversation — long histories are deterministically distilled (newest turns verbatim, older turns condensed to excerpts, oldest outlined) to fit a budget of 10% of `maxInputTokens`; and
- project-relative file metadata.

It does not include blocked sensitive files, system files, shell history, or unredacted secrets detected by the scanner.

### Sensitive Path Blocking

Sensitive locations and file types are blocked even when explicitly requested, including:

- SSH, AWS, GPG, cloud, and Kubernetes credentials
- git internals and authentication files
- private keys and service-account credentials
- `.env` variants, Terraform state/secrets, and shell history

All paths are resolved before reading, so a symlink cannot bypass these protections. External files are blocked by default and require `allowExternalFiles: true`.

### Secret Redaction

Second Opinion scans content for API keys, access tokens, JWTs, database URLs, private keys, passwords, basic-auth URLs, and similar secrets. Matches become `[REDACTED:type]`. This is a safety net, not a replacement for secret management.

Every non-dry-run creates an `.egress.json` manifest recording the provider, model, files included, external paths, and blocked files. The tool result echoes only counts (files sent, blocked, redactions) plus the manifest path; dry-run results retain the full path-level detail because they are the confirmation surface before anything leaves the machine.

### Output Directory Validation

`REVIEWS_DIR` must be a relative path and may not contain `..` traversal; absolute paths and values that resolve outside the project are rejected before anything is written. Review, prompt, and manifest files therefore always land inside the project.

### Prompt File Retention

Codex handoffs persist the complete redacted bundle on disk as `second-opinions/<name>.prompt.md`. Keep `second-opinions/` in your project's `.gitignore` (this repository already ignores it), and delete prompt files after the review is pasted if you do not want the bundled context to linger.

Only Gemini needs an API key. Do not paste `GEMINI_API_KEY` into Claude Code chat or directly into a shell command that will be saved in history; load it from a protected file or password manager.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | — | Enables Gemini and full consensus mode |
| `GEMINI_MODEL` | `gemini-pro-latest` | Gemini model |
| `CODEX_MODEL` | `gpt-5.6-sol` | Model placed in the Codex handoff command |
| `MAX_CONTEXT_TOKENS` | `200000` | Default context-bundle token budget; a per-call `maxInputTokens` overrides it |
| `MAX_OUTPUT_TOKENS` | `32768` | Maximum Gemini response tokens |
| `TEMPERATURE` | `0.3` | Gemini-only generation temperature |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Gemini API rate-limit window |
| `RATE_LIMIT_MAX_REQUESTS` | `10` | Gemini calls allowed per window |
| `REVIEWS_DIR` | `second-opinions` | Output directory relative to the project |

There is no `OPENAI_API_KEY` or `OPENAI_MODEL` setting. Codex authentication belongs to the local CLI. Reasoning effort also has no environment or tool setting: generated rescue commands intentionally omit `--effort` so the CLI inherits ultra.

### Config File

Create `~/.config/second-opinion/config.json`:

```json
{
  "geminiApiKey": "optional-gemini-key",
  "geminiModel": "gemini-pro-latest",
  "codexModel": "gpt-5.6-sol",
  "maxContextTokens": 200000,
  "maxOutputTokens": 32768,
  "temperature": 0.3,
  "rateLimitWindowMs": 60000,
  "rateLimitMaxRequests": 10,
  "reviewsDir": "second-opinions"
}
```

Environment variables take precedence.

### Custom Review Instructions

Create `~/.config/second-opinion/second-opinion.md` for global instructions, or `second-opinion.md` in a project root for project-specific instructions.

## Tool Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `provider` | Yes | — | `gemini`, `codex`, or `consensus`; deprecated `openai` normalizes to `codex` |
| `projectPath` | Yes | — | Absolute project path |
| `task` | No | — | Replacement-mode task; omit for a standard review |
| `sessionId` | No | latest | Claude Code session ID |
| `sessionName` | No | auto | Output filename stem |
| `includeFiles` | No | — | Additional files or directories |
| `allowExternalFiles` | No | `false` | Permit explicitly named files outside the project |
| `dryRun` | No | `false` | Preview egress without an API call or Codex handoff execution |
| `includeConversation` | No | `true` | Include session conversation context |
| `includeDependencies` | No | `true` | Include imported files |
| `includeDependents` | No | `true` | Include importing files |
| `includeTests` | No | `true` | Include related tests |
| `includeTypes` | No | `true` | Include referenced types |
| `maxInputTokens` | No | `200000` | Context token budget |
| `maxOutputTokens` | No | `32768` | Gemini response limit; ignored by Codex |
| `temperature` | No | `0.3` | Gemini-only temperature; ignored by Codex |
| `focusAreas` | No | — | Extra points inside the standard review methodology |

## License

MIT
