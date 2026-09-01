import { resolveAgentEntryPoint } from "../agentClient.ts";
import type { AgentConfig } from "./config.ts";

export type InstallCheck = { ok: true } | { ok: false; message: string };

/** Registry of agent kinds the "Add Agent" picker offers. `checkInstalled` is
 *  a read-only check — it verifies the kind's bridge/adapter is already
 *  resolvable and reports how to fix it if not, but never installs anything
 *  itself. Kinds that don't need a separate bridge omit it entirely. */
export interface AgentKind {
  id: AgentConfig["kind"];
  label: string;
  description: string;
  checkInstalled?: () => InstallCheck;
}

function checkBridgeInstalled(kind: AgentConfig["kind"], displayName: string): InstallCheck {
  try {
    resolveAgentEntryPoint(kind);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: `${displayName} not found: ${String(err)}. Try reinstalling the ACP Code extension.`,
    };
  }
}

export const AGENT_KINDS: readonly AgentKind[] = [
  {
    id: "claude",
    label: "Claude",
    description: "Spawns @agentclientprotocol/claude-agent-acp",
    checkInstalled: () => checkBridgeInstalled("claude", "Claude bridge (@agentclientprotocol/claude-agent-acp)"),
  },
  {
    id: "codex",
    label: "Codex",
    description: "Spawns @agentclientprotocol/codex-acp",
    checkInstalled: () => checkBridgeInstalled("codex", "Codex bridge (@agentclientprotocol/codex-acp)"),
  },
];
