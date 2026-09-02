# second-opinion — dev guide

MCP server + `/second-opinion` skill: external reviews from Gemini (API, in-process) and Codex (handoff to the local Codex CLI via the openai-codex plugin, ChatGPT-plan auth). The server never calls the OpenAI API.

Flow and options live in `second-opinion.skill.md` (installed to `~/.claude/commands/second-opinion.md`). Setup and configuration live in `README.md`.

Commands: `npm test` (vitest) · `npm run build` (tsc + installs config).

## Invariants

- No reasoning-effort option anywhere. Generated `/codex:rescue` commands omit `--effort` so the CLI inherits `model_reasoning_effort = "ultra"`; explicit flags cap at `xhigh`.
- Codex output lands in review files verbatim (splice helper or paste), never summarized or reformatted.
- OpenAI key patterns in `src/security/redactor.ts` are secret-detection rules, not provider code.
- `templates/second-opinion.md` is the single methodology source. Edit it, then run `npm run gen:template-hashes`; a test fails otherwise. The installer refreshes unmodified copies, preserves customized ones.
- The MCP wire schema derives from zod in `src/tools/review.ts`; a parity test caps its size at 2,433 B.
