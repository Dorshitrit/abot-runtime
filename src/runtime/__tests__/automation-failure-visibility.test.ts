import { afterEach, expect, test, vi } from "vitest";
import type { RegisteredToolNormalInvocation } from "../../capabilities/tool-types.js";
import type { AutomationLimits } from "../automations/limits.js";
import * as failureBoundary from "../automations/agent-request-failure.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";
import { addAgent, operation, probeTools } from "./support/automation-agent-tool-fixture.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
const fixtures: Fixture[] = [];
const policies = ["execution-agent-v1", "supervisor-worker-v1"] as const;

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  vi.restoreAllMocks();
});

async function runTextAgent(fixture: Fixture, limits: Partial<AutomationLimits> = {}) {
  const studio = fixture.application.services.automations!;
  let draft = await studio.create("Failure evidence");
  draft = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "update_definition", patch: { limits: { ...draft.definition.limits, ...limits } },
  });
  draft = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "add_node", parentSequenceId: draft.definition.body.id, index: 0,
    nodeWithoutId: {
      kind: "agent", title: "Read supplied text", onFailure: "stop",
      modelProfileId: "scheduled-model", agentMode: "reasoning",
      roleInstructions: "Read the supplied text.", prompt: "Return a short answer.",
      inputs: {}, tools: [], result: { kind: "text" },
    },
  });
  await studio.publish(draft.automationId, draft.revision);
  const run = await studio.runNow(draft.automationId);
  await expect.poll(async () => (await studio.getRun(run.id)).status,
    { timeout: 5_000, interval: 10 }).toMatch(/^(succeeded|failed)$/u);
  return studio.getRun(run.id);
}

test.each(policies)("%s retains the model limit cause through the saved run report", async (policy) => {
  const fixture = await createSchedulerRuntimeFixture(policy);
  fixtures.push(fixture);
  const run = await runTextAgent(fixture, { maxModelCallsPerRun: 1 });
  expect(run).toMatchObject({
    status: "failed", error: "automation_model_call_limit_reached",
    definition: { limits: { maxModelCallsPerRun: 1 } },
    report: { outcome: "failed", modelCalls: 1, toolCalls: 0, toolAttempts: 0,
      nodeResults: [{ status: "failed", errorCode: "automation_model_call_limit_reached" }] },
  });
  expect(fixture.invoke).toHaveBeenCalledTimes(1);
  expect(fixture.invokeRaw).not.toHaveBeenCalled();
});

test.each(policies)("%s retains the exact known timeout while redacting provider detail", async (policy) => {
  const fixture = await createSchedulerRuntimeFixture(policy);
  fixtures.push(fixture);
  fixture.invoke.mockRejectedValueOnce(new Error("request_timeout"));
  const timeout = await runTextAgent(fixture);
  expect(timeout).toMatchObject({ status: "failed", error: "request_timeout",
    report: { nodeResults: [{ errorCode: "request_timeout" }] } });
  fixture.invoke.mockRejectedValueOnce(new Error("bridge_request_failed:503:private provider body"));
  const provider = await runTextAgent(fixture);
  expect(provider).toMatchObject({ status: "failed", error: "automation_agent_provider_failed",
    report: { nodeResults: [{ errorCode: "automation_agent_provider_failed" }] } });
  expect(JSON.stringify(provider)).not.toContain("private provider body");
});

test.each(policies)("%s preserves a degraded-finalization format failure through the saved report", async (policy) => {
  const fixture = await createSchedulerRuntimeFixture(policy);
  fixtures.push(fixture);
  fixture.invoke.mockRejectedValueOnce(new Error("invalid_degraded_finalization_output"));
  const run = await runTextAgent(fixture);
  expect(run).toMatchObject({ status: "failed", error: "invalid_degraded_finalization_output",
    report: { outcome: "failed", nodeResults: [
      { status: "failed", errorCode: "invalid_degraded_finalization_output" },
    ] } });
});

test("a third control-authoring call is blocked before the tool and retains the two-call limit", async () => {
  const tools = probeTools();
  const failure = vi.spyOn(failureBoundary, "automationAgentRequestFailureCode");
  const original = tools.registry.listNormalInvocations!()[0]!;
  const registration: RegisteredToolNormalInvocation = { ...original,
    definition: { ...original.definition, params: { value: "string" } },
    contract: { ...original.contract, operations: [{
    ...original.contract.operations[0]!, input: { type: "object", additionalProperties: false,
      properties: { value: { type: "string", minLength: 1, maxLength: 80 } }, required: ["value"] },
  }] } };
  const registry = { ...tools.registry, listNormalInvocations: () => [registration],
    listDefinitions: () => [registration.definition], getDefinition: () => registration.definition };
  const fixture = await createSchedulerRuntimeFixture("execution-agent-v1", undefined, registry);
  fixtures.push(fixture);
  let decisions = 0;
  fixture.invoke.mockImplementation(async () => ({
    text: JSON.stringify({ decision: decisions++ === 0
      ? { action: "open_capability_scope", catalogGroupIds: ["identity_probe"],
          acknowledgement: "I will inspect the fixture." }
      : { action: "invoke_capability", capabilityId: operation.operationId,
          intent: "Observe the fixture.", operationObjective: "Observe the selected fixture value.",
          controlsEvidenceExecutionIds: [],
          workingDirectory: fixture.config.paths.agentWorkDir } }), meta: {},
  }));
  const studio = fixture.application.services.automations!;
  let draft = await studio.create("Two calls cannot reach a tool requiring controls");
  draft = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "update_definition", patch: { limits: { ...draft.definition.limits, maxModelCallsPerRun: 2 } },
  });
  draft = await addAgent(studio, draft, "Select operation and prepare its controls");
  await studio.replaceGrant({ automationId: draft.automationId, expectedGrantRevision: 0,
    mode: "full_access", operations: [operation], actionId: "test-grant" });
  await studio.publish(draft.automationId, draft.revision);
  const run = await studio.runNow(draft.automationId);
  await expect.poll(async () => (await studio.getRun(run.id)).status,
    { timeout: 5_000, interval: 10 }).toBe("failed");
  expect(failure).toHaveBeenCalledWith("automation_model_call_limit_reached");
  expect(await studio.getRun(run.id)).toMatchObject({ error: "automation_model_call_limit_reached",
    report: { modelCalls: 2, toolCalls: 0, toolAttempts: 0,
      nodeResults: [{ status: "failed", errorCode: "automation_model_call_limit_reached" }] } });
  expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep))
    .toEqual(["execution.decision", "execution.decision"]);
  expect(tools.execute).not.toHaveBeenCalled();
});

test("an exhausted tool limit retains attempted usage separately from verified tool executions", async () => {
  const tools = probeTools();
  const fixture = await createSchedulerRuntimeFixture("execution-agent-v1", undefined, tools.registry);
  fixtures.push(fixture);
  const studio = fixture.application.services.automations!;
  let draft = await studio.create("Two observations with one allowed attempt");
  draft = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "update_definition", patch: { limits: { ...draft.definition.limits, maxToolCallsPerRun: 1 } },
  });
  for (const title of ["First observation", "Second observation"]) {
    draft = await studio.updateDraft(draft.automationId, draft.revision, {
      kind: "add_node", parentSequenceId: draft.definition.body.id,
      index: draft.definition.body.children.length,
      nodeWithoutId: { kind: "tool", title, onFailure: "stop", operation, controls: {} },
    });
  }
  await studio.replaceGrant({ automationId: draft.automationId, expectedGrantRevision: 0,
    mode: "full_access", operations: [operation], actionId: "test-grant" });
  await studio.publish(draft.automationId, draft.revision);
  const run = await studio.runNow(draft.automationId);
  await expect.poll(async () => (await studio.getRun(run.id)).status,
    { timeout: 5_000, interval: 10 }).toBe("failed");
  const saved = await studio.getRun(run.id);
  expect(saved).toMatchObject({ error: "automation_tool_call_limit_reached",
    report: { toolCalls: 1, toolAttempts: 1, nodeResults: [
      { status: "succeeded" }, { status: "failed", errorCode: "automation_tool_call_limit_reached" },
    ] } });
  expect(tools.execute).toHaveBeenCalledTimes(1);
});
