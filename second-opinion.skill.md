---
name: second-opinion
description: Get feedback from Gemini or GPT on your current work
user-invocable: true
---

# Second Opinion Skill

Get a code review or custom feedback from an external LLM (Gemini, GPT, or both via consensus).

## Usage

- `/second-opinion` - Default consensus code review (both Gemini and GPT)
- `/second-opinion [task]` - Custom task using consensus
- `/second-opinion openai [task]` - Use GPT only
- `/second-opinion gemini [task]` - Use Gemini only
- `/second-opinion consensus [task]` - Explicitly use both (default behavior)

## Instructions

When invoked, parse the arguments:

1. Check if first word is a provider (`gemini`, `openai`, or `consensus`). If not, default to `consensus`.
2. Remaining text becomes the custom task (if any).
3. Derive a session name from the work done in this conversation (e.g., "add-auth-flow", "fix-login-bug").

Call the `mcp__second-opinion__second_opinion` tool with:
- `provider`: "gemini", "openai", or "consensus"
- `projectPath`: The current working directory (absolute path)
- `sessionName`: Descriptive name based on the work done
- `task`: The user's task text (if provided)

After the review completes, report:
- Path to the output file
- Brief summary of key findings
