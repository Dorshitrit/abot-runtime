import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { RuntimeConfig } from "../ports.js";
import { createEmptyAutomationDefinition } from "../automations/draft-mutations.js";
import { fingerprintAutomationDependencies } from "../automations/dependency-fingerprint.js";
import { invalidateRequestRunnerConfig } from "../config/runner/loader.js";
import { loadRequestRunnerConfig } from "../config/runner/loader.js";
import { projectConfiguredStepMessages } from "../config/runner/step-instructions.js";
import { projectAutomationModelDependencies } from "../automations/model-dependency-projection.js";
import type { AutomationRevision } from "../automations/definition-contracts.js";
import type { RequestExecutionPolicyId } from "../config/model-execution-policy.js";
import type { RequestContextConfig } from "../config/runner/contracts.js";

let root: string;
let config: RuntimeConfig;
const draft = createEmptyAutomationDefinition("automation", "Pinned model");
const definition = { ...draft, body: { ...draft.body, children: [{
  kind: "agent" as const, id: "agent", title: "Agent", onFailure: "stop" as const,
  modelProfileId: "selected", agentMode: "reasoning" as const, roleInstructions: "Process input",
  prompt: "Process input", inputs: {}, tools: [], result: { kind: "text" as const },
}] } };

async function writeRunner(steps: Record<string, string> = {}, instructions: Record<string, string[]> = {},
  context: Partial<RequestContextConfig> = {}) {
  const configPath = config.requestRunner.configPath;
  await writeFile(configPath, JSON.stringify({ schemaVersion: 2,
    models: { defaults: { profileId: "selected", steps } },
    context: { outputReserveTokens: 1000, safetyReserveTokens: 200, attachmentReserveTokens: 100, ...context },
    stepDefaults: { timeoutMs: 5000 },
    steps: Object.fromEntries(Object.entries(instructions).map(([step, instructionRefs]) => [step, { instructionRefs }])),
  }));
  invalidateRequestRunnerConfig({ configPath });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "automation-model-dependencies-"));
  config = { runtimeId: "dependency-test", agentBridgeUrl: "ws://unused",
    modelGatewayUrl: "http://gateway", requestRunner: { configPath: join(root, "runner.json") },
    paths: { rootDir: root, runtimeDir: join(root, "runtime"), agentWorkDir: join(root, "work"),
      sessionsDir: join(root, "sessions"), attachmentsDir: join(root, "attachments"),
      workspaceDir: join(root, "workspace"), sharedDir: join(root, "shared"),
      compiledDir: join(root, "compiled"), traceFile: join(root, "trace.jsonl") },
    models: {
      defaults: { profileId: "selected" },
      providers: { chosen: { type: "ollama", baseUrl: "http://chosen" }, other: { type: "openai" } },
      profiles: {
        selected: { provider: "chosen", model: "selected-model", contextWindowTokens: 64000 },
        other: { provider: "other", model: "other-model", contextWindowTokens: 128000 },
      },
    }, modelExecutionPolicies: { selected: { policy: "execution-agent-v1" },
      other: { policy: "supervisor-worker-v1" } },
  };
  await writeRunner();
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function fingerprint(value: AutomationRevision = definition) {
  return fingerprintAutomationDependencies({ definition: value, config, operations: [] });
}

test("unrelated models, providers, embedding profiles and execution policies do not invalidate a publication", () => {
  const before = fingerprint();
  config.models!.profiles!.other!.model = "replacement";
  config.models!.providers!.other!.baseUrl = "http://unrelated";
  config.models!.profiles!.added = { provider: "other", model: "new", contextWindowTokens: 64000 };
  config.models!.embeddingProfiles = { embedding: { provider: "other", model: "embed" } };
  config.modelExecutionPolicies = { ...config.modelExecutionPolicies, other: { policy: "execution-agent-v1" } };
  expect(fingerprint()).toBe(before);
});

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s pins each canonical runner context reserve", async (policy) => {
    config.modelExecutionPolicies = { selected: { policy } };
    const original = fingerprint();
    const budgets: readonly (keyof RequestContextConfig)[] = [
      "outputReserveTokens", "safetyReserveTokens", "attachmentReserveTokens",
    ];
    for (const budget of budgets) {
      await writeRunner({}, {}, { [budget]: 2000 });
      expect(fingerprint(), budget).not.toBe(original);
      const runner = loadRequestRunnerConfig({ configPath: config.requestRunner.configPath });
      expect(projectAutomationModelDependencies(config, [definition.body.children[0]!])?.contextBudget)
        .toEqual(runner.context);
      await writeRunner();
      expect(fingerprint()).toBe(original);
    }
  });

test("tool-only workflows ignore runner budgets and do not require the runner file", async () => {
  const toolOnly = { ...draft, body: { ...draft.body, children: [{
    kind: "tool" as const, id: "tool", title: "Read", onFailure: "stop" as const,
    operation: { toolName: "fixture", operationId: "read", contractVersion: 1 }, controls: {},
  }] } };
  const before = fingerprint(toolOnly);
  await writeRunner({}, {}, { outputReserveTokens: 2000, safetyReserveTokens: 500, attachmentReserveTokens: 300 });
  expect(fingerprint(toolOnly)).toBe(before);
  await rm(config.requestRunner.configPath);
  invalidateRequestRunnerConfig({ configPath: config.requestRunner.configPath });
  expect(fingerprint(toolOnly)).toBe(before);
});

test("equivalent runner locations keep the budget fingerprint while removing configured runner state changes it", async () => {
  const before = fingerprint();
  config.requestRunner.configPath = join(root, "equivalent-runner.json");
  await writeRunner();
  expect(fingerprint()).toBe(before);
  config.requestRunner.configPath = "";
  const unconfigured = fingerprint();
  expect(unconfigured).not.toBe(before);
  const projected = projectAutomationModelDependencies(config, [definition.body.children[0]!]);
  expect(projected?.contextBudget).toBeUndefined();
  expect(JSON.parse(JSON.stringify(projected))).not.toHaveProperty("contextBudget");
  expect(fingerprint()).toBe(unconfigured);
});

test.each(["model", "provider", "policy", "context", "removed"] as const)(
  "a selected %s dependency invalidates a publication", (dependency) => {
    const before = fingerprint();
    if (dependency === "model") config.models!.profiles!.selected!.model = "replacement";
    if (dependency === "provider") config.models!.providers!.chosen!.baseUrl = "http://replacement";
    if (dependency === "policy") config.modelExecutionPolicies = { selected: { policy: "supervisor-worker-v1" } };
    if (dependency === "context") config.models!.profiles!.selected!.contextWindowTokens = 32000;
    if (dependency === "removed") delete config.models!.profiles!.selected;
    expect(fingerprint()).not.toBe(before);
  },
);

test("calibrated profile and provider dependencies follow the canonical runner step mapping", async () => {
  config.models!.profiles!.selected!.calibration = {
    author: { profileId: "other", timeoutMs: 12000 },
  };
  await writeRunner({ "execution.response": "author" });
  const before = fingerprint();
  config.models!.profiles!.other!.model = "replacement";
  expect(fingerprint()).not.toBe(before);
  const changedModel = fingerprint();
  config.models!.providers!.other!.baseUrl = "http://changed-target";
  expect(fingerprint()).not.toBe(changedModel);
  const changedProvider = fingerprint();
  config.models!.profiles!.selected!.calibration!.author!.timeoutMs = 24000;
  expect(fingerprint()).not.toBe(changedProvider);
});

test("unused calibration slots and display labels do not invalidate a publication", () => {
  const before = fingerprint();
  config.models!.profiles!.selected!.calibration = { unused: { profileId: "other", timeoutMs: 12000 } };
  config.models!.profiles!.selected!.label = "New display label";
  expect(fingerprint()).toBe(before);
});

test("runner routing changes invalidate the publication even when platform models are unchanged", async () => {
  config.models!.profiles!.selected!.calibration = { author: { profileId: "other" } };
  const before = fingerprint();
  await writeRunner({ "execution.response": "author" });
  expect(fingerprint()).not.toBe(before);
});

test("an explicit configured override retains its routed model dependency", async () => {
  config.models!.defaults!.overrideClientPreference = true;
  await writeRunner({ "execution.response": "other" });
  const before = fingerprint();
  config.models!.profiles!.other!.model = "replacement";
  expect(fingerprint()).not.toBe(before);
});

const unusedSteps: readonly [RequestExecutionPolicyId, string][] = [
  ["execution-agent-v1", "learning.batch"], ["execution-agent-v1", "supervisor.response"],
  ["execution-agent-v1", "worker.decision"], ["execution-agent-v1", "planner.decision"],
  ["execution-agent-v1", "reviewer.decision"], ["supervisor-worker-v1", "learning.batch"],
  ["supervisor-worker-v1", "execution.response"], ["supervisor-worker-v1", "auditor.decision"],
  ["execution-agent-v1", "capability.controls"], ["execution-agent-v1", "tool_payload.raw"],
];
test.each(unusedSteps)("%s ignores mapped but unreachable %s model and provider changes", async (policy, step) => {
  config.modelExecutionPolicies = { selected: { policy } };
  config.models!.profiles!.selected!.calibration = { unreachable: { profileId: "other" } };
  const withoutMapping = fingerprint();
  await writeRunner({ [step]: "unreachable" });
  expect(fingerprint()).toBe(withoutMapping);
  config.models!.profiles!.other!.model = "unrelated-replacement";
  config.models!.providers!.other!.baseUrl = "http://unrelated-replacement";
  config.models!.profiles!.selected!.calibration!.unreachable!.timeoutMs = 12000;
  expect(fingerprint()).toBe(withoutMapping);
});

const usedSteps: readonly [RequestExecutionPolicyId, string][] = [
  ["execution-agent-v1", "execution.decision"], ["execution-agent-v1", "execution.response"],
  ["execution-agent-v1", "planner.graph"], ["execution-agent-v1", "auditor.decision"],
  ["supervisor-worker-v1", "supervisor.decision"], ["supervisor-worker-v1", "supervisor.response"],
  ["supervisor-worker-v1", "planner.decision"], ["supervisor-worker-v1", "planner.graph"],
  ["supervisor-worker-v1", "worker.decision"], ["supervisor-worker-v1", "worker.result"],
  ["supervisor-worker-v1", "reviewer.decision"], ["execution-agent-v1", "context.compact"],
  ["supervisor-worker-v1", "degraded.finalization"],
];
test.each(usedSteps)("%s retains the reachable %s model and provider dependencies", async (policy, step) => {
  config.modelExecutionPolicies = { selected: { policy } };
  config.models!.profiles!.selected!.calibration = { reachable: { profileId: "other" } };
  await writeRunner({ [step]: "reachable" });
  const before = fingerprint();
  config.models!.profiles!.other!.model = "used-replacement";
  expect(fingerprint()).not.toBe(before);
  const changedModel = fingerprint();
  config.models!.providers!.other!.baseUrl = "http://used-replacement";
  expect(fingerprint()).not.toBe(changedModel);
});

test.each(["capability.controls", "tool_payload.raw"])(
  "retains %s if any same-profile agent can use tools, regardless of node order", async (step) => {
    config.models!.profiles!.selected!.calibration = { tools: { profileId: "other" } };
    await writeRunner({ [step]: "tools" });
    const node = definition.body.children[0]!;
    const toolAgent = { ...node, id: "with-tools", tools: [{
      operation: { toolName: "fixture", operationId: "read", contractVersion: 1 }, usage: "available" as const,
    }] };
    const withTools = { ...definition, body: { ...definition.body, children: [toolAgent, node] } };
    const reverse = { ...withTools, body: { ...withTools.body, children: [node, toolAgent] } };
    const before = fingerprint(withTools);
    expect(fingerprint(reverse)).toBe(before);
    config.models!.profiles!.other!.model = "used-helper-replacement";
    expect(fingerprint(withTools)).not.toBe(before);
    expect(fingerprint(reverse)).toBe(fingerprint(withTools));
  });

test.each(usedSteps)("%s fingerprints reachable %s configured instruction content", async (policy, step) => {
  config.modelExecutionPolicies = { selected: { policy } };
  const unconfigured = fingerprint();
  await writeFile(join(root, "guidance.md"), "Original operating guidance");
  await writeRunner({}, { [step]: ["guidance.md"] });
  const original = fingerprint();
  expect(original).not.toBe(unconfigured);
  await writeFile(join(root, "guidance.md"), "Revised operating guidance");
  invalidateRequestRunnerConfig({ configPath: config.requestRunner.configPath });
  expect(fingerprint()).not.toBe(original);
  await writeRunner();
  expect(fingerprint()).toBe(unconfigured);
});

test.each(unusedSteps)("%s ignores unreachable %s configured instructions", async (policy, step) => {
  config.modelExecutionPolicies = { selected: { policy } };
  const before = fingerprint();
  await writeFile(join(root, "unrelated.md"), "Unrelated guidance");
  await writeRunner({}, { [step]: ["unrelated.md"] });
  expect(fingerprint()).toBe(before);
  await writeFile(join(root, "unrelated.md"), "Different unrelated guidance");
  invalidateRequestRunnerConfig({ configPath: config.requestRunner.configPath });
  expect(fingerprint()).toBe(before);
});

test("instruction identity uses the canonical ordered projection without copying its content", async () => {
  await writeFile(join(root, "first.md"), "First operating guidance");
  await writeFile(join(root, "second.md"), "Second operating guidance");
  const step = "execution.decision";
  await writeRunner({}, { [step]: ["first.md", "second.md"] });
  const original = fingerprint();
  const runnerConfig = loadRequestRunnerConfig({ configPath: config.requestRunner.configPath });
  const projected = projectConfiguredStepMessages({ runnerConfig, modelStep: step,
    messages: [{ role: "system", content: "Runtime contract" }] });
  const dependencies = projectAutomationModelDependencies(config, [definition.body.children[0]!]);
  const instructions = dependencies!.agents[0]!.invocations.find((item) => item.modelStep === step)!.instructions;
  expect(instructions).toEqual({ blockCount: projected.blockCount, characterCount: projected.characterCount,
    refs: projected.refs, contentHashes: projected.contentHashes });
  expect(JSON.stringify(dependencies)).not.toContain("operating guidance");
  await writeRunner({}, { [step]: ["second.md", "first.md"] });
  expect(fingerprint()).not.toBe(original);
  await writeRunner({}, { [step]: ["first.md", "second.md"] });
  await writeFile(join(root, "first.md"), " \nFirst operating guidance\n ");
  invalidateRequestRunnerConfig({ configPath: config.requestRunner.configPath });
  expect(fingerprint()).toBe(original);
  await writeFile(join(root, "alias.md"), "First operating guidance");
  await writeRunner({}, { [step]: ["alias.md", "second.md"] });
  expect(fingerprint()).not.toBe(original);
});

test.each(["capability.controls", "tool_payload.raw"])(
  "fingerprints %s instructions only when an agent can use tools", async (step) => {
    const node = definition.body.children[0]!;
    const withTools = { ...definition, body: { ...definition.body, children: [{ ...node, tools: [{
      operation: { toolName: "fixture", operationId: "read", contractVersion: 1 }, usage: "available" as const,
    }] }] } };
    const withoutToolsBefore = fingerprint();
    const withToolsBefore = fingerprint(withTools);
    await writeFile(join(root, "tool-guidance.md"), "Helper guidance");
    await writeRunner({}, { [step]: ["tool-guidance.md"] });
    expect(fingerprint()).toBe(withoutToolsBefore);
    expect(fingerprint(withTools)).not.toBe(withToolsBefore);
  });
