import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import type { RequestExecutionPolicyId } from "../../shared/request-execution-policy.js";
import type { RuntimeConfig } from "../ports.js";
import type { AutomationCatalogOperation } from "../automations/catalog.js";
import type { AgentNode, AutomationRevision, OperationRef, ToolNode } from "../automations/definition-contracts.js";
import { createEmptyAutomationDefinition } from "../automations/draft-mutations.js";
import { fingerprintAutomationDependencies } from "../automations/dependency-fingerprint.js";
import { projectAutomationModelDependencies } from "../automations/model-dependency-projection.js";
import { validateAutomationPublication } from "../automations/publication-validation.js";

const EA = "execution-agent-v1";
const SUPER = "supervisor-worker-v1";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function config(policy: RequestExecutionPolicyId = SUPER): RuntimeConfig {
  const value: Pick<RuntimeConfig, "models" | "modelExecutionPolicies"> = {
    models: { defaults: { profileId: "selected" },
      providers: { local: { type: "ollama" } },
      profiles: { selected: { provider: "local", model: "fixture", contextWindowTokens: 64000 } } },
    modelExecutionPolicies: { selected: { policy } },
  };
  return value as RuntimeConfig;
}

function operation(toolName = "external_lookup", executionPolicies?: readonly RequestExecutionPolicyId[]): AutomationCatalogOperation {
  return { toolName, operationId: "read", contractVersion: 1, label: "Read", catalogGroups: [],
    permissionMode: "full_access", effect: "read_only", approval: "request_policy",
    input: { type: "object", additionalProperties: false, properties: {}, required: [] },
    ...(executionPolicies ? { executionPolicies } : {}) };
}

function agent(id: string, operations: readonly OperationRef[]): AgentNode {
  return { kind: "agent", id, title: id, onFailure: "stop", modelProfileId: "selected",
    agentMode: "reasoning", roleInstructions: "Read the selected sources.", prompt: "Summarize.",
    inputs: {}, tools: operations.map((entry) => ({ operation: entry, usage: "available" })),
    result: { kind: "text" } };
}

function definition(...nodes: (AgentNode | ToolNode)[]): AutomationRevision {
  const draft = createEmptyAutomationDefinition("route_dependencies", "Route dependencies");
  return { ...draft, body: { ...draft.body, children: nodes } };
}

function digest(value: AutomationRevision, operations: readonly AutomationCatalogOperation[], runtime = config()) {
  return fingerprintAutomationDependencies({ definition: value, operations, config: runtime });
}

function validate(value: AutomationRevision, operations: readonly AutomationCatalogOperation[], runtime = config()) {
  return validateAutomationPublication({ definition: value, operations, config: runtime, grantMode: "full_access" });
}

test.each([EA, SUPER] as const)("%s preserves existing publications when selected operations remain available", (policy) => {
  const entry = operation();
  const value = definition(agent("reader", [entry]));
  const runtime = config(policy);
  const original = digest(value, [entry], runtime);
  const compatible = { ...entry, executionPolicies: [policy] };
  expect(digest(value, [compatible], runtime)).toBe(original);
  expect(digest(value, [{ ...entry, executionPolicies: [SUPER, EA] }], runtime)).toBe(original);
  expect(validate(value, [compatible], runtime)).toEqual([]);

  const incompatible: AutomationCatalogOperation = { ...entry, executionPolicies: [policy === EA ? SUPER : EA] };
  expect(digest(value, [incompatible], runtime)).not.toBe(original);
  expect(validate(value, [incompatible], runtime)).toEqual([expect.objectContaining({
    code: "automation_operation_unavailable", path: "nodes.reader.tools.0",
  })]);
  expect(digest(value, [entry, operation("unselected_plugin", [policy === EA ? SUPER : EA])], runtime))
    .toBe(original);
});

test("same-profile agents retain the union of their selected tools regardless of node order", () => {
  const first = operation("alpha:reader");
  const second = { ...operation("alpha"), operationId: "reader:read" };
  const blocked: AutomationCatalogOperation = { ...first, executionPolicies: [EA] };
  const firstAgent = agent("first", [first]);
  const secondAgent = agent("second", [second]);
  const noTools = agent("no_tools", []);
  const before = digest(definition(firstAgent, secondAgent, noTools), [first, second]);
  const after = digest(definition(firstAgent, secondAgent, noTools), [blocked, second]);
  expect(after).not.toBe(before);
  expect(digest(definition(noTools, secondAgent, firstAgent), [blocked, second])).toBe(after);
  const projected = projectAutomationModelDependencies(config(), [secondAgent, noTools, firstAgent], [blocked, second]);
  expect(projected!.agents).toHaveLength(1);
  expect(projected!.agents[0]!.unavailableOperations).toEqual([
    JSON.stringify([first.toolName, first.operationId, first.contractVersion]),
  ]);
});

test("direct Tool nodes stay route-less, including when an unrelated Agent uses the same model", () => {
  const entry = operation();
  const tool: ToolNode = { kind: "tool", id: "read", title: "Read", onFailure: "stop",
    operation: entry, controls: {} };
  for (const value of [definition(tool), definition(tool, agent("unrelated", []))]) {
    const before = digest(value, [entry]);
    for (const policy of [EA, SUPER] as const) {
      const restricted = { ...entry, executionPolicies: [policy] };
      expect(digest(value, [restricted])).toBe(before);
      expect(validate(value, [restricted])).toEqual([]);
    }
  }
  // A route-less workflow does not acquire a new dependency on runner configuration.
  const invalidRunner = { ...config(), requestRunner: { configPath: "/missing/unused-runner.json" } };
  expect(validate(definition(tool), [{ ...entry, executionPolicies: [EA] }], invalidRunner)).toEqual([]);
});

test.each([EA, SUPER] as const)("publication and fingerprint use the runner's effective %s route", async (policy) => {
  const runtime = config(policy === EA ? SUPER : EA);
  runtime.models!.defaults!.overrideClientPreference = true;
  runtime.models!.profiles!.routed = { provider: "local", model: "routed", contextWindowTokens: 64000 };
  runtime.modelExecutionPolicies = { ...runtime.modelExecutionPolicies, routed: { policy } };
  const root = await mkdtemp(join(tmpdir(), "automation-route-dependencies-"));
  roots.push(root);
  runtime.requestRunner = { configPath: join(root, "runner.json") };
  await writeFile(runtime.requestRunner.configPath, JSON.stringify({ schemaVersion: 2,
    models: { defaults: { profileId: "routed", steps: {} } },
    context: { outputReserveTokens: 1000, safetyReserveTokens: 200, attachmentReserveTokens: 100 },
    stepDefaults: { timeoutMs: 5000 }, steps: {},
  }));
  const entry = operation("custom_route_plugin", [policy]);
  const node = agent("reader", [entry]);
  const value = definition(node);
  expect(validate(value, [entry], runtime)).toEqual([]);
  const projection = projectAutomationModelDependencies(runtime, [node], [entry])!;
  expect(projection.agents[0]!.admission).toMatchObject({ primaryProfileId: "selected", policy: policy === EA ? SUPER : EA });
  expect(projection.agents[0]!.execution).toMatchObject({ primaryProfileId: "routed", policy });
  const unrestricted = { ...entry, executionPolicies: undefined };
  expect(digest(value, [entry], runtime)).toBe(digest(value, [unrestricted], runtime));
  const blocked: AutomationCatalogOperation = { ...entry, executionPolicies: [policy === EA ? SUPER : EA] };
  expect(validate(value, [blocked], runtime)).toEqual([expect.objectContaining({ code: "automation_operation_unavailable" })]);
  expect(digest(value, [blocked], runtime)).not.toBe(digest(value, [entry], runtime));
});

test("missing model profiles still produce admission issues instead of throwing during route checks", () => {
  const runtime = config();
  delete runtime.models!.profiles!.selected;
  const entry = operation("custom_plugin", [EA]);
  const value = definition(agent("reader", [entry]));
  expect(validate(value, [entry], runtime)).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "automation_model_unavailable", path: "nodes.reader.modelProfileId" }),
    expect.objectContaining({ code: "automation_operation_unavailable", path: "nodes.reader.tools.0" }),
  ]));
  expect(() => digest(value, [entry], runtime)).not.toThrow();
});
