// node --test src/ahp/configOptions.test.ts
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accepts,
  configSchema,
  configValues,
  modelOption,
  modelsOf,
  resolveConfig,
  resolveModelConfig,
} from "./configOptions.ts";

// Trimmed from what claude-agent-acp returns for a new session.
const options: SessionConfigOption[] = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "plan", name: "Plan", description: "Plan only" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "opus",
    options: [
      {
        group: "claude",
        name: "Claude",
        options: [
          { value: "opus", name: "Opus" },
          { value: "sonnet", name: "Sonnet" },
        ],
      },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
  { id: "sandbox", name: "Sandbox", type: "boolean", currentValue: false },
];

test("ACP mode goes to the permissions picker, the rest to generic chips", () => {
  const { properties } = configSchema(options, "claude");
  assert.deepEqual(Object.keys(properties), ["permissionMode", "acp.sandbox"]);
  assert.deepEqual(properties.permissionMode, {
    type: "string",
    title: "Mode",
    description: undefined,
    default: "default",
    sessionMutable: true,
    enum: ["default", "plan"],
    enumLabels: ["Default", "Plan"],
    enumDescriptions: ["", "Plan only"],
  });
  assert.equal(properties["acp.sandbox"].type, "boolean");
  assert.deepEqual(configValues(options, "claude"), {
    permissionMode: "default",
    "acp.sandbox": false,
  });
  assert.ok(
    "codex.permissionsPreset" in configSchema(options, "codex").properties,
  );
  assert.equal(
    resolveConfig(options, "claude", "permissionMode", "plan")?.option.id,
    "mode",
  );
  assert.equal(
    resolveConfig(options, "claude", "permissionMode", "nope"),
    undefined,
  );
  assert.equal(resolveConfig(options, "claude", "acp.mode", "plan"), undefined);
});

test("Codex collaboration mode becomes VS Code's Agent Mode picker", () => {
  const collaboration: SessionConfigOption = {
    id: "collaboration_mode",
    name: "Collaboration mode",
    category: "collaboration_mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "plan", name: "Plan" },
    ],
  };
  const { properties } = configSchema([collaboration], "codex");
  assert.deepEqual(properties.mode.enum, ["interactive", "plan"]);
  assert.equal(properties.mode.default, "interactive");
  assert.deepEqual(configValues([collaboration], "codex"), {
    mode: "interactive",
  });
  assert.deepEqual(
    resolveConfig([collaboration], "codex", "mode", "interactive")?.value,
    "default",
  );
  // Values outside the Agent Mode set keep a generic chip.
  const odd: SessionConfigOption = {
    ...collaboration,
    type: "select",
    options: [
      { value: "default", name: "Default" },
      { value: "pair", name: "Pair" },
    ],
  };
  assert.deepEqual(Object.keys(configSchema([odd], "codex").properties), [
    "acp.collaboration_mode",
  ]);
});

test("the model option becomes the model list, effort its config", () => {
  const models = modelsOf(options, "acp-claude")!;
  assert.deepEqual(
    models.map(m => m.id),
    ["opus", "sonnet"],
  );
  assert.deepEqual(Object.keys(models[0].configSchema!.properties), [
    "thinkingLevel",
  ]);
  assert.deepEqual(models[0].configSchema!.properties.thinkingLevel.enum, [
    "low",
    "high",
  ]);
  assert.equal(
    resolveModelConfig(options, "thinkingLevel", "low")?.option.id,
    "effort",
  );
  assert.equal(resolveModelConfig(options, "thinkingLevel", "max"), undefined);
  assert.equal(resolveModelConfig(options, "effort", "low"), undefined);
  assert.equal(modelsOf([], "acp-claude"), undefined);
  const model = modelOption(options)!;
  assert.ok(accepts(model, "sonnet"));
  assert.ok(!accepts(model, "default")); // AHP's placeholder model
  assert.ok(!accepts(model, undefined));
  assert.ok(accepts(options[3], true));
  assert.ok(!accepts(options[3], "on"));
});
