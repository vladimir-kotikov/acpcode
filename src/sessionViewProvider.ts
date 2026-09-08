import { RequestError, type SessionUpdate } from "@agentclientprotocol/sdk";
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { AgentConnectionPool } from "./acp/agentPool.ts";
import { getAgents } from "./acp/agents/config.ts";
import type {
  HostToSessionViewMessage,
  SessionViewMeta,
  SessionViewToHostMessage,
} from "./shared/sessionViewProtocol.ts";
import { resolveCwd } from "./workspaceUtils.ts";

/** `RequestError`'s `message` is often just the generic JSON-RPC category
 *  (e.g. "Internal error") — the agent-specific detail, when present, is in
 *  `.data`, which `String(err)` drops entirely. An *uncaught* exception in the
 *  bridge's request handler (as opposed to one it deliberately throws as a
 *  `RequestError` with its own message) gets wrapped by the ACP SDK itself as
 *  `internalError({ details: <original message> })` — unwrap that shape
 *  directly instead of dumping raw JSON at the user. */
function describeError(err: unknown): string {
  if (err instanceof RequestError) {
    const data = err.data;
    if (
      data &&
      typeof data === "object" &&
      "details" in data &&
      typeof data.details === "string"
    ) {
      return data.details;
    }
    const detail = data !== undefined ? ` ${JSON.stringify(data)}` : "";
    return `${err.message}${detail}`;
  }
  return String(err);
}

/** The `claude` CLI itself refuses to resume a session that's currently owned
 *  by a live `claude --bg` background-agent process elsewhere — ACP has no
 *  attach method, only `session/fork` (branch a copy under a new session id).
 *  Detected by message text since the failure reaches us as a generic,
 *  uncaught-exception-shaped `RequestError`, not a distinct error code. */
function isBackgroundAgentConflict(message: string): boolean {
  return message.includes("currently running as a background agent");
}

export interface SessionTarget {
  agentName: string;
  sessionId: string;
  /** The session's own recorded working directory (`SessionInfo.cwd`), NOT
   *  wherever this connection happens to be spawned — required to actually
   *  locate the session's on-disk transcript when loading it. */
  cwd: string;
  title?: string | null;
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "sessionView.js"),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "main.css"),
  );
  const hljsStyleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "hljs-theme.css"),
  );
  const nonce = crypto.randomBytes(16).toString("hex");

  return `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta
          http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
        />
        <link href="${styleUri}" rel="stylesheet" />
        <link href="${hljsStyleUri}" rel="stylesheet" />
      </head>
      <body>
        <div id="root"></div>
        <script nonce="${nonce}" src="${scriptUri}"></script>
      </body>
    </html>`;
}

/** Enough of another `SessionViewSession`'s state to seed a new one showing
 *  the exact same session without re-triggering a bridge-side history
 *  replay (see `attachSession`'s doc comment for why that matters). */
interface SessionSnapshot {
  buffer: SessionUpdate[];
  busy: boolean;
}

/** One live session bound to exactly one webview: its own connection
 *  subscription, replay buffer, and composer target. The sidebar and each
 *  "Open in Editor" tab each own one of these — switching sessions in one
 *  never affects another, they just happen to share the underlying
 *  per-agent `AgentClient` connection (which supports many concurrently
 *  loaded sessions) via the connection pool. */
class SessionViewSession implements vscode.Disposable {
  private readonly pool: AgentConnectionPool;
  private webview?: vscode.Webview;
  private ready = false;
  current?: SessionTarget;
  private buffer: SessionUpdate[] = [];
  private subscription?: vscode.Disposable;
  // True from the moment attachSession starts loading history until that
  // history has fully arrived — live updates during this window go into
  // `buffer` only (not `post`ed one at a time), so the eventual flush is a
  // single batch instead of N separate renders in the webview.
  private replayingHistory = false;
  private pendingPrompts = 0;
  // True only once this session is known-registered on the bridge — either
  // `loadSession` returned successfully, or it was seeded from a peer that
  // was itself already loaded. `current` alone isn't enough: it's set before
  // `loadSession` is even attempted, so a session whose load is still in
  // flight or that failed would otherwise look like a perfectly good peer to
  // seed from — which skips calling `loadSession` entirely (see its doc
  // comment), leaving the bridge with no record of the session at all and
  // every later `prompt`/`steer` failing with "Session not found".
  private loaded = false;

  constructor(pool: AgentConnectionPool) {
    this.pool = pool;
  }

  matches(target: Pick<SessionTarget, "agentName" | "sessionId">): boolean {
    return (
      this.loaded &&
      this.current?.agentName === target.agentName &&
      this.current?.sessionId === target.sessionId
    );
  }

  /** Resets to "no session" — used when the session this view was showing
   *  was just deleted out from under it. Drops the subscription too: a
   *  future `attachSession` call re-subscribes fresh, no stale listener
   *  sitting around filtering on an id nothing will ever match again. */
  clear(): void {
    this.subscription?.dispose();
    this.subscription = undefined;
    this.current = undefined;
    this.buffer = [];
    this.loaded = false;
    this.post({ type: "closed" });
  }

  snapshot(): SessionSnapshot | undefined {
    return this.current && this.loaded
      ? { buffer: [...this.buffer], busy: this.pendingPrompts > 0 }
      : undefined;
  }

  bind(webview: vscode.Webview): void {
    this.webview = webview;
    this.ready = false;
    webview.onDidReceiveMessage((message: SessionViewToHostMessage) => {
      switch (message.type) {
        case "ready":
          this.ready = true;
          this.replay();
          break;
        case "sendPrompt":
          void this.sendPrompt(message.text);
          break;
        case "cancelPrompt":
          this.cancelPrompt();
          break;
        case "permissionResponse":
          this.respondToPermission(message.requestId, message.optionId);
          break;
        case "forkSession":
          void this.forkSession();
          break;
      }
    });
  }

  /** `seed`, when given, means another view already has this exact session
   *  loaded: copy its buffer instead of calling `client.loadSession()`
   *  again. That call *always* re-triggers the bridge's full history replay
   *  (`loadSession` unconditionally calls `replaySessionHistory`, even for
   *  an already-loaded session) — and since every view sharing this agent's
   *  connection stays subscribed to the same `onSessionUpdate` stream, a
   *  second `loadSession` for a session another view already has open would
   *  replay that history AGAIN into every one of them, duplicating it on
   *  top of what's already shown (there's no de-dup — each `SessionUpdate`
   *  is just appended). Skipping the redundant load avoids that entirely. */
  async attachSession(
    target: SessionTarget,
    seed?: SessionSnapshot,
  ): Promise<void> {
    const agent = getAgents().find(
      candidate => candidate.name === target.agentName,
    );
    if (!agent) {
      this.post({
        type: "error",
        message: `Agent "${target.agentName}" is no longer configured.`,
      });
      return;
    }

    const client = await this.pool.connect(agent, resolveCwd());

    if (this.current?.agentName !== target.agentName) {
      this.subscription?.dispose();
      this.subscription = vscode.Disposable.from(
        client.onSessionUpdate(event => {
          if (event.sessionId !== this.current?.sessionId) {
            return;
          }
          this.buffer.push(event.update);
          if (!this.replayingHistory) {
            this.post({
              type: "update",
              sessionId: event.sessionId,
              update: event.update,
            });
          }
        }),
        client.onPermissionRequest(event => {
          if (event.sessionId !== this.current?.sessionId) {
            return;
          }
          this.post({
            type: "permissionRequest",
            requestId: event.requestId,
            sessionId: event.sessionId,
            toolCall: event.toolCall,
            options: event.options,
          });
        }),
        client.onPermissionResolved(event => {
          this.post({ type: "permissionResolved", requestId: event.requestId });
        }),
      );
    }

    this.current = target;
    this.buffer = [];
    this.loaded = false;
    this.post({
      type: "loading",
      meta: {
        agentName: target.agentName,
        sessionId: target.sessionId,
        cwd: target.cwd,
        title: target.title,
        canSteer: client.canSteer(),
      },
    });

    if (seed) {
      this.buffer = [...seed.buffer];
      this.loaded = true;
      this.post({
        type: "replayBatch",
        sessionId: target.sessionId,
        updates: this.buffer,
        busy: seed.busy,
      });
      return;
    }

    this.replayingHistory = true;
    try {
      await client.loadSession(target.sessionId, target.cwd);
      this.replayingHistory = false;
      this.loaded = true;
      this.post({
        type: "replayBatch",
        sessionId: target.sessionId,
        updates: this.buffer,
        busy: false,
      });
    } catch (err) {
      this.replayingHistory = false;
      const message = describeError(err);
      this.post({
        type: "error",
        message,
        forkable: isBackgroundAgentConflict(message),
      });
    }
  }

  /** Fallback for `attachSession` hitting `isBackgroundAgentConflict`: forks
   *  the current session's history under a new id (which nothing else owns)
   *  and re-attaches to that instead. */
  private async forkSession(): Promise<void> {
    if (!this.current) {
      return;
    }
    const target = this.current;
    const agent = getAgents().find(
      candidate => candidate.name === target.agentName,
    );
    if (!agent) {
      this.post({
        type: "error",
        message: `Agent "${target.agentName}" is no longer configured.`,
      });
      return;
    }
    try {
      const client = await this.pool.connect(agent, resolveCwd());
      const forked = await client.forkSession(target.sessionId, target.cwd);
      await this.attachSession({
        agentName: target.agentName,
        sessionId: forked.sessionId,
        cwd: target.cwd,
        title: target.title ? `${target.title} (fork)` : undefined,
      });
    } catch (err) {
      this.post({ type: "error", message: describeError(err) });
    }
  }

  private async sendPrompt(text: string): Promise<void> {
    if (!this.current) {
      return;
    }
    const target = this.current;
    const agent = getAgents().find(
      candidate => candidate.name === target.agentName,
    );
    if (!agent) {
      this.post({
        type: "error",
        message: `Agent "${target.agentName}" is no longer configured.`,
      });
      return;
    }
    const client = await this.pool.connect(agent, resolveCwd());
    // A turn is already in flight (per our own pending count) and this agent
    // supports steering: inject into it instead of starting a fresh
    // `session/prompt`, which the running turn would treat as an interrupt.
    // The original send's own await below still owns busy-clearing for the
    // whole (now extended) turn — this call doesn't wait for it to finish.
    const steering = this.pendingPrompts > 0 && client.canSteer();
    this.pendingPrompts += 1;
    try {
      if (steering) {
        await client.steer(target.sessionId, text);
        return;
      }
      const result = await client.prompt(target.sessionId, text);
      if (result.failureTitle) {
        this.post({ type: "error", message: result.failureTitle });
      } else {
        this.post({
          type: "promptStopped",
          sessionId: target.sessionId,
          stopReason: result.stopReason,
        });
      }
    } catch (err) {
      this.post({ type: "error", message: describeError(err) });
    } finally {
      this.pendingPrompts -= 1;
    }
  }

  private cancelPrompt(): void {
    if (!this.current) {
      return;
    }
    this.pool.get(this.current.agentName)?.cancelPrompt(this.current.sessionId);
  }

  private respondToPermission(
    requestId: string,
    optionId: string | null,
  ): void {
    if (!this.current) {
      return;
    }
    this.pool
      .get(this.current.agentName)
      ?.resolvePermission(requestId, optionId);
  }

  /** Sent on every `"ready"` — both the true first load and a reconnect
   *  (webview was torn down and recreated while hidden, or otherwise lost
   *  its state). `buffer` is authoritative regardless of which case this
   *  is, so this alone is sufficient to bring a webview fully up to date. */
  private replay(): void {
    if (!this.current) {
      return;
    }
    this.post({
      type: "loading",
      meta: {
        agentName: this.current.agentName,
        sessionId: this.current.sessionId,
        cwd: this.current.cwd,
        title: this.current.title,
        canSteer: this.pool.get(this.current.agentName)?.canSteer() ?? false,
      },
    });
    this.post({
      type: "replayBatch",
      sessionId: this.current.sessionId,
      updates: this.buffer,
      busy: this.pendingPrompts > 0,
    });
  }

  private post = (message: HostToSessionViewMessage) => {
    if (this.ready) {
      void this.webview?.postMessage(message);
    }
  };

  dispose = () => this.subscription?.dispose();
}

/** Session transcript viewer with a live composer (send/cancel a prompt,
 *  respond to permission requests). The sidebar section and each "Open in
 *  Editor" tab are independent `SessionViewSession`s — switching sessions in
 *  one never changes what another shows; only "Open in Editor" with no
 *  target (the sidebar's own title-bar button) seeds a new editor session
 *  from whatever the sidebar currently shows, then they diverge. */
export class SessionViewProvider
  implements
    vscode.WebviewViewProvider,
    vscode.WebviewPanelSerializer<SessionViewMeta | undefined>,
    vscode.Disposable
{
  private readonly extensionUri: vscode.Uri;
  private readonly pool: AgentConnectionPool;
  private readonly sidebar: SessionViewSession;
  // Keyed by session (not panel) so closeSession can look up which panel to
  // dispose for a given target without a separate parallel structure.
  private readonly editors = new Map<SessionViewSession, vscode.WebviewPanel>();

  constructor(extensionUri: vscode.Uri, pool: AgentConnectionPool) {
    this.extensionUri = extensionUri;
    this.pool = pool;
    this.sidebar = new SessionViewSession(pool);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = renderHtml(
      webviewView.webview,
      this.extensionUri,
    );
    this.sidebar.bind(webviewView.webview);
  }

  async openSession(target: SessionTarget): Promise<void> {
    await vscode.commands.executeCommand("acpcode.sessionView.focus");
    await this.sidebar.attachSession(
      target,
      this.findPeer(target, this.sidebar)?.snapshot(),
    );
  }

  /** Opens a session in a full editor tab, independent from the sidebar and
   *  any other editor tab from this point on. Passing `target` (e.g. from a
   *  tree item's context menu/inline button) opens that session directly;
   *  with no argument (the sessionView's own title-bar button) it seeds the
   *  new tab from whatever the sidebar currently shows. */
  openInEditor = async (target?: SessionTarget): Promise<void> => {
    const resolvedTarget = target ?? this.sidebar.current;
    if (!resolvedTarget) {
      void vscode.window.showInformationMessage("Open a session first.");
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "acpcode.sessionViewEditor",
      `${resolvedTarget.agentName} — ${resolvedTarget.title ?? resolvedTarget.sessionId}`,
      vscode.ViewColumn.Active,
      // retainContextWhenHidden is panel.options, not webview.options — only
      // settable here, at creation. deserializeWebviewPanel doesn't get a
      // say: VS Code already decided it when it reconstructed the panel.
      { retainContextWhenHidden: true },
    );
    const session = this.bindPanel(panel);
    await session.attachSession(
      resolvedTarget,
      this.findPeer(resolvedTarget)?.snapshot(),
    );
  };

  /** `WebviewPanelSerializer` for `"acpcode.sessionViewEditor"` (registered in
   *  extension.ts) — without one, VS Code doesn't attempt to restore these
   *  tabs across a window reload at all, it just drops them. `state` is
   *  whatever the webview last passed to its own `vscode.setState()` (see
   *  sessionView.ts): the `SessionViewMeta` of the session it was showing. */
  deserializeWebviewPanel = async (
    panel: vscode.WebviewPanel,
    state: SessionViewMeta | undefined,
  ): Promise<void> => {
    const session = this.bindPanel(panel);
    if (!state) {
      return;
    }
    const target: SessionTarget = {
      agentName: state.agentName,
      sessionId: state.sessionId,
      cwd: state.cwd,
      title: state.title,
    };
    await session.attachSession(
      target,
      this.findPeer(target, session)?.snapshot(),
    );
  };

  private bindPanel(panel: vscode.WebviewPanel): SessionViewSession {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    panel.webview.html = renderHtml(panel.webview, this.extensionUri);
    const session = new SessionViewSession(this.pool);
    session.bind(panel.webview);
    this.editors.set(session, panel);
    panel.onDidDispose(() => {
      session.dispose();
      this.editors.delete(session);
    });
    return session;
  }

  /** Finds another live session (sidebar or an editor tab) already showing
   *  `target`, so the caller can seed from it instead of reloading. */
  private findPeer = (target: SessionTarget, exclude?: SessionViewSession) =>
    [this.sidebar, ...this.editors.keys()].find(
      session => session !== exclude && session.matches(target),
    );

  /** A deleted session shouldn't keep showing stale content: reset the
   *  sidebar to "no session" if it was showing this one, and close (not just
   *  clear) any editor tab showing it — those are actual closeable tabs, so
   *  leaving an empty one open would be more confusing than useful. */
  closeSession(target: Pick<SessionTarget, "agentName" | "sessionId">): void {
    if (this.sidebar.matches(target)) {
      this.sidebar.clear();
    }
    const panelsToClose = [...this.editors]
      .filter(([session]) => session.matches(target))
      .map(([, panel]) => panel);
    for (const panel of panelsToClose) {
      panel.dispose();
    }
  }

  dispose = (): void =>
    [this.sidebar, ...this.editors.keys()].forEach(d => d.dispose());
}
