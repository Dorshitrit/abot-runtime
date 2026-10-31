import { afterEach, expect, test, vi } from "vitest";
import type { RegisteredToolNormalInvocation } from "../../capabilities/tool-types.js";
import type { ToolRegistry } from "../ports.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";
import { directRespondText } from "./support/supervisor-direct-respond.js";
import { withSupervisorPreparation } from "./support/supervisor-model-phases.js";

const fixtures: Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

test("a source-free Agent automation uses the selected policy and writes a Run report without a chat", async () => {
  const fixture = await createSchedulerRuntimeFixture("execution-agent-v1");
  fixtures.push(fixture);
  const studio = fixture.application.services.automations!;
  const created = await studio.create("Intake summary");
  const objective = await studio.updateDraft(created.automationId, created.revision, {
    kind: "update_definition",
    patch: { objective: "Give one concise report." },
  });
  const draft = await studio.updateDraft(created.automationId, objective.revision, {
    kind: "add_node",
    parentSequenceId: objective.definition.body.id,
    index: 0,
    nodeWithoutId: {
      kind: "agent",
      title: "Summarize",
      onFailure: "stop",
      modelProfileId: "scheduled-model",
      agentMode: "reasoning",
      roleInstructions: "Summarize the input.",
      prompt: "Return a short completion.",
      inputs: {},
      tools: [],
      result: { kind: "text" },
    },
  });
  await studio.publish(created.automationId, draft.revision);
  const launched = await studio.runNow(created.automationId);
  let report;
  await expect.poll(async () => {
    const current = await studio.getRun(launched.id);
    report = current.report;
    return current.status;
  }, { timeout: 8_000, interval: 10 }).toBe("succeeded");
  expect(report).toMatchObject({
    automationId: created.automationId,
    outcome: "succeeded",
    modelCalls: expect.any(Number),
    toolCalls: 0,
  });
  expect(fixture.invoke).toHaveBeenCalled();
  const sessions = await fixture.application.services.sessions.listSessions();
  expect(sessions.sessions.some((session) => session.title === "Summarize")).toBe(false);
});

test("a settled Run keeps its actual outcome when only the compact report exceeds its artifact budget", async () => {
  const fixture = await createSchedulerRuntimeFixture("execution-agent-v1");
  fixtures.push(fixture);
  const studio = fixture.application.services.automations!;
  const created = await studio.create("Small report budget");
  const limited = await studio.updateDraft(created.automationId, created.revision, {
    kind: "update_definition",
    patch: { limits: { ...created.definition.limits, maxStoredArtifactBytes: 256 } },
  });
  const draft = await studio.updateDraft(created.automationId, limited.revision, {
    kind: "add_node", parentSequenceId: limited.definition.body.id, index: 0,
    nodeWithoutId: {
      kind: "agent", title: "Summarize", onFailure: "stop",
      modelProfileId: "scheduled-model", agentMode: "reasoning",
      roleInstructions: "Summarize.", prompt: "Return a short answer.",
      inputs: {}, tools: [], result: { kind: "text" },
    },
  });
  await studio.publish(created.automationId, draft.revision);
  const launched = await studio.runNow(created.automationId);
  await expect.poll(async () => (await studio.getRun(launched.id)).status,
    { timeout: 8_000, interval: 10 }).toBe("succeeded");
  expect(await studio.getRun(launched.id)).toMatchObject({
    reportRef: `derived:${launched.id}`,
    report: { outcome: "succeeded", nodeResults: [{ status: "succeeded" }] },
  });
});

test("a published Agent refuses a changed model profile before making a call", async () => {
  const fixture = await createSchedulerRuntimeFixture("execution-agent-v1");
  fixtures.push(fixture);
  const studio = fixture.application.services.automations!;
  const created = await studio.create("Pinned model");
  const draft = await studio.updateDraft(created.automationId, created.revision, {
    kind: "add_node", parentSequenceId: created.definition.body.id, index: 0,
    nodeWithoutId: {
      kind: "agent", title: "Summarize", onFailure: "stop",
      modelProfileId: "scheduled-model", agentMode: "reasoning",
      roleInstructions: "Summarize.", prompt: "Return a result.",
      inputs: {}, tools: [], result: { kind: "text" },
    },
  });
  await studio.publish(created.automationId, draft.revision);
  fixture.config.models!.profiles!["scheduled-model"]!.model = "different-model";
  const launched = await studio.runNow(created.automationId);
  await expect.poll(async () => (await studio.getRun(launched.id)).status,
    { timeout: 8_000, interval: 10 }).toBe("failed");
  expect(await studio.getRun(launched.id)).toMatchObject({
    error: "automation_contract_changed",
    report: { outcome: "failed" },
  });
  expect(fixture.invoke).not.toHaveBeenCalled();
});

test("a manual tool-only automation records one operation and uses no model", async () => {
  const registration: RegisteredToolNormalInvocation = {
    toolName: "example_read",
    definition: {
      name: "example_read", routingCapability: "semantic_lookup",
      executionEffect: "read_only", params: { key: "string" },
    },
    contract: { version: 1, operations: [{
      operationId: "read", summary: "Read one value", effect: "read_only",
      approval: "request_policy", input: {
        type: "object", additionalProperties: false,
        properties: { key: { type: "string", minLength: 1, maxLength: 50 } },
        required: ["key"],
      },
    }] },
  };
  const execute = vi.fn(async () => ({
    ok: true, tool: "example_read", output: "value", producedNewInformation: true,
  }));
  const tools: ToolRegistry = {
    listDefinitions: () => [registration.definition],
    listNormalInvocations: () => [registration],
    getDefinition: (name) => name === registration.toolName ? registration.definition : undefined,
    hasToolsAvailable: () => true,
    getImplementations: () => ({}),
    execute,
  };
  const fixture = await createSchedulerRuntimeFixture("execution-agent-v1", undefined, tools);
  fixtures.push(fixture);
  const studio = fixture.application.services.automations!;
  const created = await studio.create("Read one value");
  const operation = { toolName: "example_read", operationId: "read", contractVersion: 1 };
  await studio.replaceGrant({
    automationId: created.automationId, expectedGrantRevision: 0,
    mode: "full_access", operations: [operation], actionId: "test-user-grant",
  });
  const draft = await studio.updateDraft(created.automationId, created.revision, {
    kind: "add_node", parentSequenceId: created.definition.body.id, index: 0,
    nodeWithoutId: {
      kind: "tool", title: "Read", onFailure: "stop", operation,
      controls: { key: { kind: "literal", value: "name" } },
    },
  });
  await studio.publish(created.automationId, draft.revision);
  const launched = await studio.runNow(created.automationId);
  await expect.poll(async () => (await studio.getRun(launched.id)).status,
    { timeout: 8_000, interval: 10 }).toBe("succeeded");
  expect(await studio.getRun(launched.id)).toMatchObject({
    report: { outcome: "succeeded", modelCalls: 0,
      nodeResults: [{ status: "succeeded", resultRef: expect.any(String) }] },
  });
  expect(execute).toHaveBeenCalledOnce();
  expect(fixture.invoke).not.toHaveBeenCalled();
});

test("Run again creates a separate reported run of the published revision", async () => {
  const fixture = await createSchedulerRuntimeFixture("execution-agent-v1");
  fixtures.push(fixture);
  const studio = fixture.application.services.automations!;
  const created = await studio.create("Repeatable report");
  const draft = await studio.updateDraft(created.automationId, created.revision, {
    kind: "add_node", parentSequenceId: created.definition.body.id, index: 0,
    nodeWithoutId: {
      kind: "agent", title: "Report", onFailure: "stop",
      modelProfileId: "scheduled-model", agentMode: "reasoning",
      roleInstructions: "Report.", prompt: "Return a report.",
      inputs: {}, tools: [], result: { kind: "text" },
    },
  });
  await studio.publish(created.automationId, draft.revision);
  const first = await studio.runNow(created.automationId);
  await expect.poll(async () => (await studio.getRun(first.id)).status,
    { timeout: 8_000, interval: 10 }).toBe("succeeded");
  const second = await studio.rerun(first.id, "confirmed-repeat-1", true);
  const duplicate = await studio.rerun(first.id, "confirmed-repeat-1", true);
  expect(duplicate.id).toBe(second.id);
  expect(second).toMatchObject({
    replayOf: first.id,
    target: { definitionRevision: draft.revision },
  });
  await expect.poll(async () => (await studio.getRun(second.id)).status,
    { timeout: 8_000, interval: 10 }).toBe("succeeded");
  expect((await studio.getRun(first.id)).report).toMatchObject({ outcome: "succeeded" });
  expect((await studio.getRun(second.id)).report).toMatchObject({ outcome: "succeeded" });
});

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s receives and validates the automation JSON contract without an extra model call",
  async (policy) => {
    const fixture = await createSchedulerRuntimeFixture(policy);
    fixtures.push(fixture);
    fixture.invoke.mockImplementation(withSupervisorPreparation(async (input) => {
      if (input.modelStep === "execution.decision") return {
        text: JSON.stringify({ decision: {
          action: "respond",
        } }), meta: {},
      };
      if (input.modelStep === "supervisor.decision") return {
        text: directRespondText("I have the result."), meta: {},
      };
      if (input.modelStep === "execution.response" || input.modelStep === "supervisor.response")
        return { text: '{"label":"done"}', meta: {} };
      throw new Error(`unexpected_step:${input.modelStep}`);
    }));
    const studio = fixture.application.services.automations!;
    const created = await studio.create("Structured report");
    const objective = await studio.updateDraft(created.automationId, created.revision, {
      kind: "update_definition", patch: { objective: "Return one status label." },
    });
    const draft = await studio.updateDraft(created.automationId, objective.revision, {
      kind: "add_node", parentSequenceId: objective.definition.body.id, index: 0,
      nodeWithoutId: {
        kind: "agent", title: "Classify", onFailure: "stop",
        modelProfileId: "scheduled-model", agentMode: "reasoning",
        roleInstructions: "Classify the input.", prompt: "Produce the result.",
        inputs: {}, tools: [],
        result: { kind: "json", schema: {
          type: "object", additionalProperties: false,
          properties: { label: { type: "string", minLength: 1, maxLength: 20 } },
          required: ["label"],
        } },
      },
    });
    await studio.publish(created.automationId, draft.revision);
    const launched = await studio.runNow(created.automationId);
    await expect.poll(async () => (await studio.getRun(launched.id)).status,
      { timeout: 8_000, interval: 10 }).toBe("succeeded");
    const response = fixture.invoke.mock.calls.find(([input]) =>
      input.modelStep === "execution.response" || input.modelStep === "supervisor.response")?.[0];
    expect(response?.format).toMatchObject({ type: "json_schema", name: "automation_step_result" });
    expect(fixture.invoke).toHaveBeenCalledTimes(policy === "supervisor-worker-v1" ? 3 : 2);
  },
);
