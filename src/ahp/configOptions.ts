// ACP session config options → AHP. The model option becomes the agent's
// model list, effort-like options become each model's config (VS Code shows
// them inside the model picker), and the rest become session config chips.
import type {
  SessionConfigOption,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import type { AgentConfig } from "../acp/agents/config.ts";
import type {
  ConfigSchema,
  SessionConfigPropertySchema,
  SessionConfigSchema,
  SessionModelInfo,
} from "@microsoft/agent-host-protocol";

export type ConfigValue = string | boolean;
type AgentKind = AgentConfig["kind"];

/** Where a session-level option shows up in VS Code's chat input, and how
 *  its values translate (ACP value → AHP value; unlisted ones pass as-is). */
interface Placement {
  key: string;
  toAhp: Record<string, string>;
}

// The keys native Claude and Codex use for their permission modes. VS Code
// renders whatever values these have in a dedicated picker.
const PERMISSIONS_KEY: Record<AgentKind, string> = {
  claude: "permissionMode",
  codex: "codex.permissionsPreset",
};
// VS Code's Agent Mode picker (`mode`) only appears for values within this
// set that include "interactive".
const AGENT_MODES = new Set(["interactive", "plan", "autopilot"]);
// Anything else gets a generic chip. The prefix keeps it clear of keys VS
// Code reserves for its dedicated pickers.
const KEY_PREFIX = "acp.";

function placement(option: SessionConfigOption, kind: AgentKind): Placement {
  if (option.category === "mode") {
    return { key: PERMISSIONS_KEY[kind], toAhp: {} };
  }
  if (option.category === "collaboration_mode") {
    const toAhp: Record<string, string> = { default: "interactive" };
    const values = choices(option).map(v => toAhp[v.value] ?? v.value);
    if (
      values.includes("interactive") &&
      values.every(v => AGENT_MODES.has(v))
    ) {
      return { key: "mode", toAhp };
    }
  }
  return { key: KEY_PREFIX + option.id, toAhp: {} };
}

const toAhp = (where: Placement, value: ConfigValue): ConfigValue =>
  typeof value === "string" ? (where.toAhp[value] ?? value) : value;

const fromAhp = (where: Placement, value: unknown): unknown =>
  typeof value === "string"
    ? (Object.entries(where.toAhp).find(([, v]) => v === value)?.[0] ?? value)
    : value;

// The model is picked through AHP's own model list, not session config.
const isModel = (option: SessionConfigOption): boolean =>
  option.category === "model";

// Effort goes in the model's config, which VS Code shows in the model
// picker's details, but only under keys it knows; native hosts use this one.
// Other model tuning (e.g. Claude's fast mode, category `model_config`) has
// no such key and stays a session chip.
const EFFORT_KEY = "thinkingLevel";
const isModelConfig = (option: SessionConfigOption): boolean =>
  option.category === "thought_level";

const isSessionConfig = (option: SessionConfigOption): boolean =>
  !isModel(option) && !isModelConfig(option);

function choices(option: SessionConfigOption): SessionConfigSelectOption[] {
  if (option.type !== "select") {
    return [];
  }
  return option.options.flatMap(item =>
    "group" in item ? item.options : [item],
  );
}

function property(
  option: SessionConfigOption,
  where: Placement = { key: option.id, toAhp: {} },
): SessionConfigPropertySchema {
  const common = {
    title: option.name,
    description: option.description ?? undefined,
    default: toAhp(where, option.currentValue),
    sessionMutable: true,
  };
  if (option.type === "boolean") {
    return { ...common, type: "boolean" };
  }
  const values = choices(option);
  return {
    ...common,
    type: "string",
    enum: values.map(v => toAhp(where, v.value) as string),
    enumLabels: values.map(v => v.name),
    enumDescriptions: values.some(v => v.description)
      ? values.map(v => v.description ?? "")
      : undefined,
  };
}

export function configSchema(
  options: SessionConfigOption[],
  kind: AgentKind,
): SessionConfigSchema {
  return {
    type: "object",
    properties: Object.fromEntries(
      options.filter(isSessionConfig).map(o => {
        const where = placement(o, kind);
        return [where.key, property(o, where)];
      }),
    ),
  };
}

export function configValues(
  options: SessionConfigOption[],
  kind: AgentKind,
): Record<string, ConfigValue> {
  return Object.fromEntries(
    options.filter(isSessionConfig).map(o => {
      const where = placement(o, kind);
      return [where.key, toAhp(where, o.currentValue)];
    }),
  );
}

/** The ACP option and value an AHP session config entry stands for, if it
 *  names one with a value that option accepts. */
export function resolveConfig(
  options: SessionConfigOption[],
  kind: AgentKind,
  key: string,
  value: unknown,
): { option: SessionConfigOption; value: ConfigValue } | undefined {
  for (const option of options.filter(isSessionConfig)) {
    const where = placement(option, kind);
    const acpValue = fromAhp(where, value);
    if (where.key === key && accepts(option, acpValue)) {
      return { option, value: acpValue };
    }
  }
  return undefined;
}

/** The agent's models, or undefined when it doesn't offer a choice. */
export function modelsOf(
  options: SessionConfigOption[],
  provider: string,
): SessionModelInfo[] | undefined {
  const model = options.find(isModel);
  const values = model ? choices(model) : [];
  const effort = options.find(isModelConfig);
  // ponytail: ACP options are per session, not per model, so every model
  // gets the same effort levels even where one doesn't support them (e.g.
  // haiku); the agent rejects or ignores those values.
  const configSchema: ConfigSchema | undefined = effort
    ? { type: "object", properties: { [EFFORT_KEY]: property(effort) } }
    : undefined;
  return values.length
    ? values.map(v => ({ id: v.value, provider, name: v.name, configSchema }))
    : undefined;
}

/** The ACP option and value a `ModelSelection.config` entry stands for. */
export function resolveModelConfig(
  options: SessionConfigOption[],
  key: string,
  value: unknown,
): { option: SessionConfigOption; value: ConfigValue } | undefined {
  const effort = options.find(isModelConfig);
  return key === EFFORT_KEY && effort && accepts(effort, value)
    ? { option: effort, value }
    : undefined;
}

export const modelOption = (
  options: SessionConfigOption[],
): SessionConfigOption | undefined => options.find(isModel);

/** Whether `value` is one the option accepts. */
export function accepts(
  option: SessionConfigOption,
  value: unknown,
): value is ConfigValue {
  return option.type === "boolean"
    ? typeof value === "boolean"
    : choices(option).some(v => v.value === value);
}
