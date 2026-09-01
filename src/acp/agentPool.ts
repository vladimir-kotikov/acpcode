import * as vscode from "vscode";
import { AgentClient } from "./agentClient.ts";
import type { AgentConfig } from "./agents/config.ts";

/** Connect-on-demand, cache-by-name registry of live agent connections,
 *  shared by anything that needs to talk to a configured agent (the sessions
 *  tree, the session viewer). Keeps exactly one subprocess per agent name
 *  regardless of how many consumers are looking at it. */
export class AgentConnectionPool implements vscode.Disposable {
  private readonly clients = new Map<string, AgentClient>();

  async connect(agent: AgentConfig, cwd: string): Promise<AgentClient> {
    const existing = this.clients.get(agent.name);
    if (existing) {
      return existing;
    }
    const client = new AgentClient(cwd, agent.name);
    await client.connect(agent);
    this.clients.set(agent.name, client);
    return client;
  }

  get(agentName: string): AgentClient | undefined {
    return this.clients.get(agentName);
  }

  /** Drops one broken/stale connection so the next `connect()` for that
   *  agent reconnects fresh, without disturbing other agents' connections. */
  disconnect(agentName: string): void {
    const client = this.clients.get(agentName);
    if (client) {
      client.dispose();
      this.clients.delete(agentName);
    }
  }

  /** Drops every cached connection so the next `connect()` reconnects fresh. */
  disposeAll(): void {
    for (const client of this.clients.values()) {
      client.dispose();
    }
    this.clients.clear();
  }

  dispose(): void {
    this.disposeAll();
  }
}
