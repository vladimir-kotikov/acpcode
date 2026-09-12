import * as vscode from "vscode";
import { AgentClient } from "./agentClient.ts";
import type { AgentConfig } from "./agents/config.ts";

/** Connect-on-demand, cache-by-name registry of live agent connections,
 *  shared by anything that needs to talk to a configured agent (the sessions
 *  tree, the session viewer). Keeps exactly one subprocess per agent name
 *  regardless of how many consumers are looking at it. */
export class AgentConnectionPool implements vscode.Disposable {
  private readonly clients = new Map<string, AgentClient>();
  // Tracks connects still in flight so concurrent callers for the same agent
  // (tree refresh, newSession, attachSession all call connect()) share the
  // one attempt instead of racing to create duplicates — `clients` only gets
  // its entry once `client.connect()` resolves, so without this, every
  // caller that arrives before that finishes sees no cached client and
  // spawns its own subprocess + output channel, and only the last one to
  // finish ends up in `clients` — every earlier one leaks (never disposed)
  // while other code may still be holding onto it.
  private readonly connecting = new Map<string, Promise<AgentClient>>();

  async connect(agent: AgentConfig, cwd: string): Promise<AgentClient> {
    const existing = this.clients.get(agent.name);
    if (existing) {
      return existing;
    }
    const inFlight = this.connecting.get(agent.name);
    if (inFlight) {
      return inFlight;
    }
    const promise = (async () => {
      const client = new AgentClient(cwd, agent.name);
      await client.connect(agent);
      this.clients.set(agent.name, client);
      return client;
    })();
    this.connecting.set(agent.name, promise);
    try {
      return await promise;
    } finally {
      this.connecting.delete(agent.name);
    }
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
