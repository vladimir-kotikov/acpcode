import { withAgentCli } from "../bridges.ts";
import type { AgentConfig } from "./config.ts";

export type InstallCheck = { ok: true } | { ok: false; message: string };

/** Registry of agent kinds the "Add Agent" picker offers. `checkInstalled` is
 *  a read-only check — it verifies the kind's agent CLI is installed and
 *  reports how to fix it if not, but never installs anything itself. (The
 *  ACP bridge needs no check: it's installed on first connect.) Kinds that
 *  need nothing installed omit it entirely. */
export interface AgentKind {
  id: AgentConfig["kind"];
  label: string;
  description: string;
  checkInstalled?: () => InstallCheck;
}

function checkCliInstalled(kind: AgentConfig["kind"]): InstallCheck {
  try {
    withAgentCli(kind, process.env);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export const AGENT_KINDS: readonly AgentKind[] = [
  {
    id: "claude",
    label: "Claude",
    description: "Spawns @agentclientprotocol/claude-agent-acp",
    checkInstalled: () => checkCliInstalled("claude"),
  },
  {
    id: "codex",
    label: "Codex",
    description: "Spawns @agentclientprotocol/codex-acp",
    checkInstalled: () => checkCliInstalled("codex"),
  },
];
