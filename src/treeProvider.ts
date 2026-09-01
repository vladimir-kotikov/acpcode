import type { SessionInfo } from "@agentclientprotocol/sdk";
import * as os from "node:os";
import * as path from "node:path";
import { match } from "ts-pattern";
import * as vscode from "vscode";
import type { AgentClient } from "./acp/agentClient.ts";
import type { AgentConnectionPool } from "./acp/agentPool.ts";
import { getAgents, type AgentConfig } from "./acp/agents/config.ts";
import { getGroupSessionsByCwd, getSessionScope } from "./settings.ts";
import { resolveCwd } from "./workspaceUtils.ts";

type MaybePromise<T> = T | Promise<T>;

const identity = <T>(x: T): T => x;

const uniq = <T, K = T>(
  arr: T[],
  keyFn: (item: T) => K = identity as (item: T) => K,
): T[] =>
  Object.values(Object.fromEntries(arr.map(item => [keyFn(item), item])));

type TreeNode =
  | { kind: "agent"; agent: AgentConfig }
  | {
      kind: "cwdGroup";
      agent: AgentConfig;
      cwd: string;
      // sessions: SessionInfo[];
    }
  | { kind: "session"; agent: AgentConfig; session: SessionInfo }
  | { kind: "message"; text: string; isError: boolean };

const agentTreeItem = (agent: AgentConfig) => ({
  label: agent.name,
  collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
  iconPath: new vscode.ThemeIcon("robot"),
  description: agent.kind,
  contextValue: "acpcode.agent",
});

const cwdTreeItem = (cwd: string) => ({
  label: path.basename(cwd) || cwd,
  collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
  iconPath: new vscode.ThemeIcon("folder"),
  tooltip: cwd,
  contextValue: "acpcode.cwdGroup",
});

const sessionTreeItem = (session: SessionInfo, agent: AgentConfig) => ({
  label: session.title ?? session.sessionId,
  collapsibleState: vscode.TreeItemCollapsibleState.None,
  iconPath: new vscode.ThemeIcon("comment-discussion"),
  description: session.updatedAt
    ? new Date(session.updatedAt).toLocaleString()
    : undefined,
  tooltip: session.cwd,
  contextValue: "acpcode.session",
  command: {
    command: "acpcode.openSession",
    title: "Open Session",
    arguments: [
      {
        agentName: agent.name,
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: session.title,
      },
    ],
  },
});

const messageTreeNode = (label: string, isError: boolean) => ({
  label,
  collapsibleState: vscode.TreeItemCollapsibleState.None,
  iconPath: new vscode.ThemeIcon(isError ? "error" : "info"),
});

const bySessionRecency = (a: SessionInfo, b: SessionInfo) =>
  (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");

/** Sessions tree, grouped by configured agent. Each agent node lazily connects
 *  (via the shared pool) on first expand, so the list reflects actual
 *  `session/list` results rather than a static config dump. */
export class SessionsTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly pool: AgentConnectionPool;
  private readonly changeEmitter = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
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
        // force every agent to reconnect, not ju;st re-list.
        this.pool.disposeAll();
        this.changeEmitter.fire();
      }
    });
  }

  /** Re-renders without touching existing connections — a live session
   *  viewer stays connected across a plain "Refresh Sessions" click. */
  refresh = () => this.changeEmitter.fire();

  getTreeItem = (node: TreeNode): vscode.TreeItem =>
    match(node)
      .with({ kind: "agent" }, ({ agent }) => agentTreeItem(agent))
      .with({ kind: "cwdGroup" }, ({ cwd }) => cwdTreeItem(cwd))
      .with({ kind: "session" }, ({ session, agent }) =>
        sessionTreeItem(session, agent),
      )
      .with({ kind: "message" }, ({ text, isError }) =>
        messageTreeNode(text, isError),
      )
      .exhaustive();

  getChildren = (node?: TreeNode): MaybePromise<TreeNode[]> =>
    match(node)
      .returnType<MaybePromise<TreeNode[]>>()
      .with({ kind: "session" }, () => [])
      .with({ kind: "message" }, () => [])
      .with({ kind: "cwdGroup" }, ({ agent, cwd }) =>
        this.pool
          .connect(agent, cwd)
          .then(client => this.listSessionsForScope(client, cwd))
          .then(sessions =>
            sessions.length === 0
              ? [
                  {
                    kind: "message" as const,
                    text: "No sessions",
                    isError: false,
                  },
                ]
              : sessions.sort(bySessionRecency).map(session => ({
                  kind: "session" as const,
                  agent,
                  session,
                })),
          )
          .catch(err => {
            this.pool.disconnect(agent.name);
            return [{ kind: "message", text: String(err), isError: true }];
          }),
      )
      .with({ kind: "agent" }, async ({ agent }) =>
        this.pool
          .connect(agent, resolveCwd())
          .then(client => this.listSessionsForScope(client))
          .then(sessions =>
            sessions.length === 0
              ? [
                  {
                    kind: "message" as const,
                    text: "No sessions",
                    isError: false,
                  },
                ]
              : getGroupSessionsByCwd()
                ? uniq<string, string>(sessions.map(s => s.cwd)).map(cwd => ({
                    kind: "cwdGroup" as const,
                    agent,
                    cwd,
                  }))
                : sessions.sort(bySessionRecency).map(session => ({
                    kind: "session" as const,
                    agent,
                    session,
                  })),
          )
          .catch(err => {
            this.pool.disconnect(agent.name);
            return [
              { kind: "message" as const, text: String(err), isError: true },
            ];
          }),
      )
      .with(undefined, () => {
        const agents = getAgents();
        return agents.length === 0
          ? [
              {
                kind: "message",
                text: 'No agents configured — run "ACP Code: Add Agent".',
                isError: false,
              },
            ]
          : agents.map(agent => ({ kind: "agent", agent }));
      })
      .exhaustive();

  /** "all": unfiltered session/list (across every project the agent knows
   *  about). "workspace": one session/list call per open workspace folder,
   *  merged and deduped — falls back to the home directory when no folder
   *  is open, since that's what a bare-window agent would have spawned into. */

  private listSessionsForScope = (client: AgentClient, cwd?: string) => {
    if (cwd !== undefined) {
      return client.listSessions(cwd);
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    return getSessionScope() === "all"
      ? client.listSessions()
      : folders.length === 0
        ? client.listSessions(os.homedir())
        : Promise.all(
            folders.map(folder => client.listSessions(folder.uri.fsPath)),
          ).then(sessions => uniq(sessions.flat(), s => s.sessionId));
  };

  dispose = () => this.configListener.dispose();
}
