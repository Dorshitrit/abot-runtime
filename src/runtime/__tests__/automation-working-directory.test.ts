import { isAbsolute, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { RegisteredToolNormalInvocation } from "../../capabilities/tool-types.js";
import type { RuntimeConfig, ToolRegistry } from "../ports.js";
import { createEmptyAutomationDefinition } from "../automations/draft-mutations.js";
import { parseAutomationDefinition } from "../automations/definition-input.js";
import * as publication from "../automations/publication-validation.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

const operation = { toolName: "reader", operationId: "read", contractVersion: 1 };
const registration: RegisteredToolNormalInvocation = {
  toolName: operation.toolName,
  definition: { name: operation.toolName, routingCapability: "semantic_lookup",
    executionEffect: "read_only", params: {} },
  contract: { version: 1, operations: [{
    operationId: operation.operationId, summary: "Read", effect: "read_only", approval: "request_policy",
    input: { type: "object", additionalProperties: false, properties: {}, required: [] },
  }] },
};

function definition(workingDirectory?: string) {
  const draft = createEmptyAutomationDefinition("automation", "Directory boundary");
  return { ...draft, ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    body: { ...draft.body, children: [{ kind: "tool" as const, id: "read", title: "Read",
      onFailure: "stop" as const, operation, controls: {} }] } };
}

function validate(workingDirectory?: string) {
  return publication.validateAutomationPublication({
    definition: definition(workingDirectory), config: {} as RuntimeConfig, grantMode: "full_access",
    operations: [{ ...registration.contract.operations[0]!, ...operation,
      label: "Read", catalogGroups: [], permissionMode: "full_access" }],
  });
}

test.each([".", "relative/path", "../outside", isAbsolute("C:\\outside") ? "C:relative" : "C:\\outside"])(
  "rejects an execution-incompatible working directory %s during validation", (directory) => {
    expect(validate(directory)).toEqual([expect.objectContaining({
      code: "automation_working_directory_invalid", path: "workingDirectory",
    })]);
    // Historical records remain readable; execution admission owns their rejection.
    expect(parseAutomationDefinition(definition(directory)).workingDirectory).toBe(directory);
  },
);

test("accepts the configured default and a runtime-native absolute override", () => {
  expect(validate()).toEqual([]);
  expect(validate(resolve("automation-test-work"))).toEqual([]);
});

async function fixture() {
  const execute = vi.fn<ToolRegistry["execute"]>(async () => ({
    ok: true, tool: operation.toolName, output: "Read", producedNewInformation: true,
  }));
  const registry: ToolRegistry = {
    listDefinitions: () => [registration.definition], listNormalInvocations: () => [registration],
    getDefinition: () => registration.definition, hasToolsAvailable: () => true,
    getImplementations: () => ({}), execute,
  };
  const runtime = await createSchedulerRuntimeFixture("execution-agent-v1", undefined, registry);
  fixtures.push(runtime);
  return { ...runtime, execute };
}

async function draftWithAgentAndTool(runtime: Fixture, workingDirectory?: string) {
  const studio = runtime.application.services.automations!;
  const created = await studio.create("Directory boundary");
  await studio.replaceGrant({ automationId: created.automationId, expectedGrantRevision: 0,
    mode: "full_access", operations: [operation], actionId: "explicit-test-grant" });
  let draft = await studio.updateDraft(created.automationId, created.revision, {
    kind: "add_node", parentSequenceId: created.definition.body.id, index: 0,
    nodeWithoutId: { kind: "agent", title: "Analyze", onFailure: "stop", modelProfileId: "scheduled-model",
      agentMode: "fast", roleInstructions: "Analyze", prompt: "Return analysis", inputs: {}, tools: [],
      result: { kind: "text" } },
  });
  draft = await studio.updateDraft(created.automationId, draft.revision, {
    kind: "add_node", parentSequenceId: created.definition.body.id, index: 1,
    nodeWithoutId: { kind: "tool", title: "Read", onFailure: "stop", operation, controls: {} },
  });
  if (workingDirectory === undefined) return draft;
  return studio.updateDraft(created.automationId, draft.revision, {
    kind: "update_definition", patch: { workingDirectory },
  });
}

test("Studio rejects a relative directory before publication without discarding the editable draft", async () => {
  const runtime = await fixture();
  const studio = runtime.application.services.automations!;
  const draft = await draftWithAgentAndTool(runtime, ".");
  expect(await studio.validate(draft.automationId)).toEqual([expect.objectContaining({
    code: "automation_working_directory_invalid", path: "workingDirectory",
  })]);
  await expect(studio.publish(draft.automationId, draft.revision)).rejects.toMatchObject({
    issues: [expect.objectContaining({ code: "automation_working_directory_invalid", path: "workingDirectory" })],
  });
  expect((await studio.getDraft(draft.automationId))?.definition.workingDirectory).toBe(".");
  expect(await runtime.scheduler.getAutomationJob(draft.automationId)).toBeNull();
  expect(runtime.invoke).not.toHaveBeenCalled();
  expect(runtime.execute).not.toHaveBeenCalled();
});

test("admission rejects a legacy relative directory before either agent or tool execution", async () => {
  const runtime = await fixture();
  const studio = runtime.application.services.automations!;
  const draft = await draftWithAgentAndTool(runtime, ".");
  // Simulate a definition published before this validation existed; admission stays real.
  const legacyPublisher = vi.spyOn(publication, "validateAutomationPublication").mockReturnValueOnce([]);
  await studio.publish(draft.automationId, draft.revision);
  legacyPublisher.mockRestore();
  const run = await studio.runNow(draft.automationId);
  await expect.poll(async () => (await studio.getRun(run.id)).status, { timeout: 8_000, interval: 10 }).toBe("failed");
  expect(await studio.getRun(run.id)).toMatchObject({ error: "automation_working_directory_invalid" });
  expect(runtime.invoke).not.toHaveBeenCalled();
  expect(runtime.execute).not.toHaveBeenCalled();
  expect((await studio.getPublishedDefinition(draft.automationId))?.workingDirectory).toBe(".");
});

test.each(["default", "absolute"])("%s directory still permits agent and tool execution", async (mode) => {
  const runtime = await fixture();
  const studio = runtime.application.services.automations!;
  const directory = mode === "absolute" ? join(runtime.rootDir, "selected-work") : undefined;
  const draft = await draftWithAgentAndTool(runtime, directory);
  await studio.publish(draft.automationId, draft.revision);
  const run = await studio.runNow(draft.automationId);
  await expect.poll(async () => (await studio.getRun(run.id)).status, { timeout: 8_000, interval: 10 }).toBe("succeeded");
  expect(runtime.invoke).toHaveBeenCalled();
  expect(runtime.execute).toHaveBeenCalledOnce();
  expect(runtime.execute.mock.calls[0]![1]?.requestWorkingDirectory)
    .toBe(directory ?? runtime.config.paths.agentWorkDir);
});
