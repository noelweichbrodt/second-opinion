---
name: second-opinion
description: Get feedback from Gemini or GPT on your current work
user-invocable: true
---

# Second Opinion Skill

Get a code review or custom feedback from an external LLM (Gemini or GPT).

## Usage

- `/second-opinion` - Default code review from Gemini
- `/second-opinion [task]` - Custom task for Gemini
- `/second-opinion openai [task]` - Use GPT instead
- `/second-opinion gemini [task]` - Explicitly use Gemini

## Instructions

When invoked, parse the arguments:

1. Check if first word is a provider (`gemini` or `openai`). If not, default to `gemini`.
2. Remaining text becomes the custom task (if any).
3. Derive a session name from the work done in this conversation (e.g., "add-auth-flow", "fix-login-bug").

Call the `mcp__second-opinion__second_opinion` tool with:
- `provider`: "gemini", "openai", or "consensus"
- `projectPath`: The current working directory (absolute path)
- `sessionName`: Descriptive name based on the work done
- `customPrompt`: The user's task text (if provided, passed as the `customPrompt` parameter)

After the review completes, report:
- Path to the output file
- Brief summary of key findings
