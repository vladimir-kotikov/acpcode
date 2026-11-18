import type { AvailableCommand, SessionUpdate } from "@agentclientprotocol/sdk";
import type { Form, FormRequest } from "../forms.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import type { AgentConfig } from "./config.ts";

/** What sets one kind of agent apart. Everything about an agent that isn't
 *  ACP lives in its kind, so code serving every agent never asks which one it
 *  serves. Hooks a kind leaves out mean plain ACP. */
export interface AgentKind {
  label: string;
  /** Shown in the "Add Agent" picker. */
  description: string;
  /** The ACP bridge's npm package and which key in its `bin` map to spawn,
   *  plus the agent CLI the bridge drives: found on the user's machine and
   *  handed over in `cliEnv`, which the bridge checks before falling back to
   *  its bundled copy. `cliDirs` are searched besides PATH. */
  bridge: {
    packageName: string;
    binName: string;
    cli: string;
    cliEnv: string;
    cliDirs: string[];
  };
  /** The key VS Code's native harness for this agent gives its permission
   *  modes, which VS Code renders in a dedicated picker. */
  permissionsKey: string;
  /** The slash command that drops the conversation so far from the agent's
   *  context. Bridges don't list it among their commands, and nothing in ACP
   *  says it ran, so the client adds it and resets the transcript itself. */
  resetCommand?: AvailableCommand;
  /** An update as it arrives, in terms every agent shares. */
  mapUpdate?: (update: SessionUpdate) => SessionUpdate;
  /** ACP's request for a form, in terms every agent shares; one question per
   *  property without it. */
  formOf?: (request: FormRequest) => Form;
  /** What else runs the session, e.g. the agent's CLI in a terminal: while
   *  it does, the session is only shown. `env` is the agent's. */
  sessionOwner?: (
    env: NodeJS.ProcessEnv,
    sessionId: string,
  ) => Promise<string | undefined>;
  /** Removes what the agent keeps running for a deleted or archived session;
   *  answers what to log. */
  removeJob?: (env: NodeJS.ProcessEnv, sessionId: string) => Promise<string>;
}

export const KINDS: Readonly<Record<AgentConfig["kind"], AgentKind>> = {
  claude,
  codex,
};
