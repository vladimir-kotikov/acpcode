import * as os from "node:os";

/** A configured, connectable agent instance. `kind` is a literal union so
 *  adding a second agent type later is a type error everywhere it needs
 *  handling, not a silent gap. */
export interface AgentConfig {
  name: string;
  kind: "claude" | "codex";
  env?: Record<string, string>;
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return os.homedir() + value.slice(1);
  }
  return value;
}

/** Environment overlay for spawning this agent's ACP subprocess, expanding
 *  `~` in values the way a shell would (mirrors `CLAUDE_CONFIG_DIR=~/.claude-personal`). */
export function agentEnv(agent: AgentConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(agent.env ?? {})) {
    env[key] = expandHome(value);
  }
  return env;
}
