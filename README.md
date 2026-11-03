# acpcode

Yet another ACP-based agentic chat for VS Code. Talks to ACP agents (Claude, Codex) and shows sessions in a sidebar tree + webview.

## Requirements

- The agent's own CLI, installed and logged in: [Claude Code](https://code.claude.com) (`claude`) and/or [Codex](https://github.com/openai/codex) (`codex`). Set `CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH` in an agent's `env` if it isn't on PATH.
- `npm` (comes with Node.js): each agent's ACP bridge is installed into the extension's global storage when an agent of that kind is configured. Update with **ACP Code: Update Agent Bridges**, or pin a version with `acpcode.bridgeVersions`.

## Extension Settings

- `acpcode.agents`: configured agents shown in the Sessions view.
- `acpcode.bridgeVersions`: npm version (or range) of an agent's ACP bridge to install instead of the latest, e.g. `{ "claude": "0.93.0" }`.
- `acpcode.sessionScope`: `all` or `workspace` — which sessions to list per agent.
- `acpcode.groupSessionsByCwd`: group sessions by working directory.

## Release Notes

See CHANGELOG.md.
