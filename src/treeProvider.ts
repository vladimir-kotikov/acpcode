import type { SessionInfo } from "@agentclientprotocol/sdk";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentClient } from "./acp/agentClient.ts";
import type { AgentConnectionPool } from "./acp/agentPool.ts";
import { getAgents, type AgentConfig } from "./acp/agents/config.ts";
import { getGroupSessionsByCwd, getSessionScope } from "./settings.ts";
import { resolveCwd } from "./workspaceUtils.ts";

type TreeNode =
  | { kind: "agent"; agent: AgentConfig }
  | { kind: "cwdGroup"; agent: AgentConfig; cwd: string; sessions: SessionInfo[] }
  | { kind: "session"; agent: AgentConfig; session: SessionInfo }
  | { kind: "message"; text: string; isError: boolean };

/** Sessions tree, grouped by configured agent. Each agent node lazily connects
 *  (via the shared pool) on first expand, so the list reflects actual
 *  `session/list` results rather than a static config dump. */
export class SessionsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly pool: AgentConnectionPool;
  private readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined | void>();
  private readonly configListener: vscode.Disposable;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(pool: AgentConnectionPool) {
    this.pool = pool;
    this.configListener = vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration("acpcode.agents") ||
        event.affectsConfiguration("acpcode.sessionScope") ||
        event.affectsConfiguration("acpcode.groupSessionsByCwd")
      ) {
        // Agent definitions themselves may have changed (env vars, etc.) —
        // force every agent to reconnect, not just re-list.
        this.pool.disposeAll();
        this.changeEmitter.fire();
      }
    });
  }

  /** Re-renders without touching existing connections — a live session
   *  viewer stays connected across a plain "Refresh Sessions" click. */
  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "agent") {
      const item = new vscode.TreeItem(node.agent.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon("robot");
      item.description = node.agent.kind;
      item.contextValue = "acpcode.agent";
      return item;
    }
    if (node.kind === "cwdGroup") {
      const item = new vscode.TreeItem(path.basename(node.cwd) || node.cwd, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon("folder");
      item.description = `${node.sessions.length} session${node.sessions.length === 1 ? "" : "s"}`;
      item.tooltip = node.cwd;
      item.contextValue = "acpcode.cwdGroup";
      return item;
    }
    if (node.kind === "session") {
      const item = new vscode.TreeItem(node.session.title ?? node.session.sessionId, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("comment-discussion");
      item.description = node.session.updatedAt ? new Date(node.session.updatedAt).toLocaleString() : undefined;
      item.tooltip = node.session.cwd;
      item.contextValue = "acpcode.session";
      item.command = {
        command: "acpcode.openSession",
        title: "Open Session",
        arguments: [
          {
            agentName: node.agent.name,
            sessionId: node.session.sessionId,
            cwd: node.session.cwd,
            title: node.session.title,
          },
        ],
      };
      return item;
    }
    const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(node.isError ? "error" : "info");
    return item;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      const agents = getAgents();
      if (agents.length === 0) {
        return [
          {
            kind: "message",
            text: 'No agents configured — run "ACP Code: Add Agent".',
            isError: false,
          },
        ];
      }
      return agents.map(agent => ({ kind: "agent", agent }));
    }
    if (node.kind === "cwdGroup") {
      return node.sessions.map(session => ({ kind: "session", agent: node.agent, session }));
    }
    if (node.kind !== "agent") {
      return [];
    }
    try {
      const client = await this.pool.connect(node.agent, resolveCwd());
      const sessions = (await this.listSessionsForScope(client)).sort((a, b) =>
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
      );
      if (sessions.length === 0) {
        return [{ kind: "message", text: "No sessions", isError: false }];
      }
      if (getGroupSessionsByCwd()) {
        const groups = new Map<string, SessionInfo[]>();
        for (const session of sessions) {
          const existing = groups.get(session.cwd);
          if (existing) {
            existing.push(session);
          } else {
            groups.set(session.cwd, [session]);
          }
        }
        // `sessions` is already sorted most-recent-first, and Map preserves
        // insertion order, so groups come out ordered by their most recent session.
        return [...groups.entries()].map(([cwd, groupSessions]) => ({
          kind: "cwdGroup",
          agent: node.agent,
          cwd,
          sessions: groupSessions,
        }));
      }
      return sessions.map(session => ({
        kind: "session",
        agent: node.agent,
        session,
      }));
    } catch (err) {
      this.pool.disconnect(node.agent.name);
      return [{ kind: "message", text: String(err), isError: true }];
    }
  }

  /** "all": unfiltered session/list (across every project the agent knows
   *  about). "workspace": one session/list call per open workspace folder,
   *  merged and deduped — falls back to the home directory when no folder
   *  is open, since that's what a bare-window agent would have spawned into. */
  private async listSessionsForScope(client: AgentClient): Promise<SessionInfo[]> {
    if (getSessionScope() === "all") {
      return client.listSessions();
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return client.listSessions(os.homedir());
    }
    const perFolder = await Promise.all(folders.map(folder => client.listSessions(folder.uri.fsPath)));
    const merged = new Map<string, SessionInfo>();
    for (const sessions of perFolder) {
      for (const session of sessions) {
        merged.set(session.sessionId, session);
      }
    }
    return [...merged.values()];
  }

  dispose(): void {
    this.configListener.dispose();
  }
}
