import type { SessionInfo } from "@agentclientprotocol/sdk";
import * as path from "node:path";
import { match } from "ts-pattern";
import * as vscode from "vscode";
import type { AgentClient } from "./acp/agentClient.ts";
import type { AgentConnectionPool } from "./acp/agentPool.ts";
import { getAgents, type AgentConfig } from "./acp/agents/config.ts";
import type { SessionViewProvider } from "./sessionViewProvider.ts";
import { getGroupSessionsByCwd } from "./settings.ts";
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
  private readonly sessionViewProvider: SessionViewProvider;
  private readonly changeEmitter = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  private readonly configListener: vscode.Disposable;
  private readonly workspaceFoldersListener: vscode.Disposable;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    pool: AgentConnectionPool,
    sessionViewProvider: SessionViewProvider,
  ) {
    this.pool = pool;
    this.sessionViewProvider = sessionViewProvider;
    this.configListener = vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration("acpcode.agents") ||
        event.affectsConfiguration("acpcode.groupSessionsByCwd")
      ) {
        // Agent definitions themselves may have changed (env vars, etc.) —
        // force every agent to reconnect, not ju;st re-list.
        this.pool.disposeAll();
        this.changeEmitter.fire();
      }
    });
    // Adding/removing a folder changes what `getChildren`'s cwdGroup union
    // (open folders + cwds with sessions) should show, but touches neither
    // "acpcode.agents" nor "acpcode.groupSessionsByCwd" — without this the
    // tree never learns a folder was added until something else (e.g. an
    // agent reconnect) happens to trigger a refresh.
    this.workspaceFoldersListener =
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh());
  }

  /** Re-renders without touching existing connections — a live session
   *  viewer stays connected across a plain "Refresh Sessions" click. */
  refresh = () => this.changeEmitter.fire();

  /** Invoked from a session row's context menu/inline button, which VS Code
   *  calls with the raw tree node (not a vscode.TreeItem) as the arg. */
  deleteSession = async (node: {
    agent: { name: string };
    session: { sessionId: string; title?: string | null };
  }): Promise<void> => {
    const label = node.session.title ?? node.session.sessionId;
    const confirmed = await vscode.window.showWarningMessage(
      `Delete session "${label}"? This can't be undone.`,
      { modal: true },
      "Delete",
    );
    if (confirmed !== "Delete") {
      return;
    }
    const agent = getAgents().find(
      candidate => candidate.name === node.agent.name,
    );
    if (!agent) {
      return;
    }
    const client = await this.pool.connect(agent, resolveCwd());
    await client.deleteSession(node.session.sessionId);
    this.sessionViewProvider.closeSession({
      agentName: node.agent.name,
      sessionId: node.session.sessionId,
    });
    this.refresh();
  };

  /** Invoked from a cwd-group row (with that cwd) or an agent row (falls back
   *  to the workspace cwd, matching how the ungrouped list is scoped). */
  newSession = async (node: {
    agent: { name: string };
    cwd?: string;
  }): Promise<void> => {
    const agent = getAgents().find(
      candidate => candidate.name === node.agent.name,
    );
    if (!agent) {
      return;
    }
    const cwd = node.cwd ?? resolveCwd();
    const client = await this.pool.connect(agent, cwd);
    const response = await client.newSession(cwd);
    await this.sessionViewProvider.openSession({
      agentName: agent.name,
      sessionId: response.sessionId,
      cwd,
    });
    this.refresh();
  };

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
          .then(sessions => {
            if (!getGroupSessionsByCwd()) {
              return sessions.length === 0
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
                  }));
            }
            // Every currently open folder gets a group even with zero
            // sessions yet — otherwise there's no row to hang the "New
            // Session" inline button off, and no way to create the first
            // session for a folder through the tree at all. Session-only
            // cwds (a folder that's since been closed) are appended after,
            // so they don't disappear from history either.
            const openFolderCwds = (
              vscode.workspace.workspaceFolders ?? []
            ).map(folder => folder.uri.fsPath);
            const cwds = uniq([...openFolderCwds, ...sessions.map(s => s.cwd)]);
            return cwds.length === 0
              ? [
                  {
                    kind: "message" as const,
                    text: "No sessions",
                    isError: false,
                  },
                ]
              : cwds.map(cwd => ({ kind: "cwdGroup" as const, agent, cwd }));
          })
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

  /** One `session/list` call per currently-open workspace folder, merged and
   *  deduped. No "list every session this agent has ever seen" mode: the
   *  underlying agents disagree on what that even means — Claude's session
   *  storage is project-scoped and its SDK silently narrows an unscoped
   *  `session/list` to a single project, while Codex's is date-scoped and
   *  genuinely global — so a per-cwd listing is the only option that behaves
   *  the same regardless of which agent is connected. No folder open means
   *  nothing to list. */
  private listSessionsForScope = (client: AgentClient, cwd?: string) => {
    if (cwd !== undefined) {
      return client.listSessions(cwd);
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    return Promise.all(
      folders.map(folder => client.listSessions(folder.uri.fsPath)),
    ).then(sessions => uniq(sessions.flat(), s => s.sessionId));
  };

  dispose = () => {
    this.configListener.dispose();
    this.workspaceFoldersListener.dispose();
  };
}
