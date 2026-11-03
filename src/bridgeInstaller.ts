import * as os from "node:os";
import * as vscode from "vscode";
import { AgentClient } from "./acp/agentClient.ts";
import type { AgentConfig } from "./acp/agents/config.ts";
import {
  bridgePackage,
  installBridge,
  installedBridge,
} from "./acp/bridges.ts";
import { getAgents } from "./settings.ts";

type Kind = AgentConfig["kind"];

let log: vscode.OutputChannel | undefined;
const output = () =>
  (log ??= vscode.window.createOutputChannel("ACP Code: Bridges"));

/** The npm version spec to install: the user's pin from
 *  `acpcode.bridgeVersions`, else the latest release. */
const bridgeSpec = (kind: Kind): string =>
  vscode.workspace
    .getConfiguration("acpcode")
    .get<Partial<Record<Kind, string>>>("bridgeVersions", {})
    [kind]?.trim() || "latest";

/** Installs the bridges the configured agents need. With `update`, every one
 *  is re-resolved against the registry (a newer `latest`, or a newer match of
 *  a pinned range); without it, only a missing bridge or one installed for a
 *  different pin is, so a normal startup never touches the network. Resolves to
 *  whether any install changed. */
export async function installBridges(update: boolean): Promise<boolean> {
  const agents = getAgents();
  const kinds = [...new Set(agents.map(agent => agent.kind))];
  if (update && kinds.length === 0) {
    void vscode.window.showInformationMessage(
      "ACP Code: no agents configured, so no bridges to update.",
    );
  }
  const changed = await Promise.all(
    kinds.map(async kind => {
      const spec = bridgeSpec(kind);
      if (!update && installedBridge(kind)?.spec === spec) {
        return false;
      }
      // The probe spawns the bridge as this agent would, so a CLI path set
      // in its env (CLAUDE_CODE_EXECUTABLE / CODEX_PATH) is honored.
      const agent = agents.find(a => a.kind === kind)!;
      return installWithProgress(agent, spec);
    }),
  );
  return changed.some(Boolean);
}

/** Resolves to whether the install changed; failures are shown, not thrown. */
async function installWithProgress(
  agent: AgentConfig,
  spec: string,
): Promise<boolean> {
  const pkg = bridgePackage(agent.kind);
  const cwd =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "ACP Code",
      },
      progress =>
        installBridge(
          agent.kind,
          spec,
          entry => AgentClient.probe(agent, entry, cwd, output()),
          step => {
            output().appendLine(step);
            progress.report({ message: step });
          },
        ),
    );
    const message = result.changed
      ? `${pkg}@${result.version} installed and verified${result.previous ? ` (replacing ${result.previous})` : ""}.`
      : `${pkg} is up to date (${result.version}).`;
    output().appendLine(message);
    void vscode.window.showInformationMessage(`ACP Code: ${message}`);
    return result.changed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output().appendLine(message);
    // Not awaited: the toast stays up until dismissed.
    void vscode.window
      .showErrorMessage(
        `ACP Code: couldn't install ${pkg}@${spec}: ${message}`,
        "Show Log",
      )
      .then(choice => choice && output().show());
    return false;
  }
}
