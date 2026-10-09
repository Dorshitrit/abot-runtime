import { afterEach, expect, test, vi } from "vitest";
import type {
  RegisteredToolNormalInvocation,
  ToolCall,
  ToolExecutionResult,
} from "../../capabilities/tool-types.js";
import type { AutomationDraftRecord } from "../automations/storage-records.js";
import type { ToolRegistry } from "../ports.js";
import {
  createSchedulerRuntimeFixture,
  scheduledModelMessages,
  type ScheduledModelInput,
} from "./support/scheduler-runtime-fixture.js";
import { directRespondText } from "./support/supervisor-direct-respond.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
type Studio = NonNullable<Fixture["application"]["services"]["automations"]>;
type Policy = "execution-agent-v1" | "supervisor-worker-v1";

const fixtures: Fixture[] = [];
const invoiceId = "invoice-AB73";
const sourceOperation = {
  toolName: "handoff_source", operationId: "read", contractVersion: 1,
} as const;
const sinkOperation = {
  toolName: "handoff_sink", operationId: "write", contractVersion: 1,
} as const;

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

function toolFixture(sourceSucceeds: boolean) {
  const source: RegisteredToolNormalInvocation = {
    toolName: sourceOperation.toolName,
    definition: {
      name: sourceOperation.toolName, routingCapability: "semantic_lookup",
      executionEffect: "read_only", params: { key: "string" },
    },
    contract: { version: 1, operations: [{
      operationId: sourceOperation.operationId, summary: "Read a record",
      effect: "read_only", approval: "request_policy",
      input: { type: "object", additionalProperties: false,
        properties: { key: { type: "string", minLength: 1, maxLength: 40 } },
        required: ["key"] },
    }] },
  };
  const sink: RegisteredToolNormalInvocation = {
    toolName: sinkOperation.toolName,
    definition: {
      name: sinkOperation.toolName, routingCapability: "semantic_mutation",
      executionEffect: "mutating", params: { label: "string", body: "string" },
    },
    contract: { version: 1, operations: [{
      operationId: sinkOperation.operationId, summary: "Write a record",
      effect: "mutating", approval: "request_policy",
      input: { type: "object", additionalProperties: false,
        properties: { label: { type: "string", minLength: 1, maxLength: 200 } },
        required: ["label"] },
      payload: { kind: "raw_text", param: "body", instructions: "Write the result.",
        minBytes: 1, maxBytes: 200 },
    }] },
  };
  const registrations = [source, sink];
  const execute = vi.fn(async (call: ToolCall): Promise<ToolExecutionResult> => {
    if (call.tool === sourceOperation.toolName) return sourceSucceeds
      ? { ok: true, tool: call.tool, output: `Observed ${invoiceId}`,
          producedNewInformation: true, data: { invoiceId } }
      : { ok: false, tool: call.tool, output: "Source unavailable",
          producedNewInformation: false, errorCode: "source_unavailable" };
    if (call.tool === sinkOperation.toolName) return {
      ok: true, tool: call.tool, output: "Recorded", producedNewInformation: true,
    };
    throw new Error(`unexpected_tool:${call.tool}`);
  });
  const registry: ToolRegistry = {
    listDefinitions: () => registrations.map((item) => item.definition),
    listNormalInvocations: () => registrations,
    getDefinition: (name) => registrations.find((item) => item.toolName === name)?.definition,
    hasToolsAvailable: () => true,
    getImplementations: () => ({}),
    execute,
  };
  return { registry, execute };
}

function assignmentFrom(input: ScheduledModelInput): {
  kind: string;
  inputs: Record<string, unknown>;
} {
  const marker = '{"kind":"automation_node_assignment_v2"';
  const message = scheduledModelMessages(input).find((item) =>
    item.role === "user" && item.content.includes(marker));
  if (!message) throw new Error("automation_assignment_missing_from_model_context");
  return JSON.parse(message.content.slice(message.content.indexOf(marker))) as {
    kind: string; inputs: Record<string, unknown>;
  };
}

function scriptModel(fixture: Fixture) {
  const observed: { step: string; inputs: Record<string, unknown>; content: string }[] = [];
  fixture.invoke.mockImplementation(async (input) => {
    const assignment = assignmentFrom(input);
    const content = JSON.stringify(scheduledModelMessages(input));
    observed.push({ step: String(input.modelStep), inputs: assignment.inputs, content });
    const source = assignment.inputs.source;
    const response = source === undefined ? "independent-result" : `processed:${String(source)}`;
    if (input.modelStep === "supervisor.decision") return {
      text: directRespondText("Step completed."), meta: {},
    };
    if (input.modelStep === "execution.decision") return {
      text: JSON.stringify({ decision: { action: "respond", acknowledgement: "Step completed." } }),
      meta: {},
    };
    if (input.modelStep === "supervisor.response" || input.modelStep === "execution.response")
      return { text: response, meta: {} };
    throw new Error(`unexpected_model_step:${input.modelStep}`);
  });
  return observed;
}

async function addNode(studio: Studio, draft: AutomationDraftRecord,
  nodeWithoutId: Record<string, unknown>): Promise<AutomationDraftRecord> {
  return studio.updateDraft(draft.automationId, draft.revision, {
    kind: "add_node", parentSequenceId: draft.definition.body.id,
    index: draft.definition.body.children.length, nodeWithoutId,
  });
}

async function grantAndPublish(studio: Studio, draft: AutomationDraftRecord) {
  await studio.replaceGrant({
    automationId: draft.automationId, expectedGrantRevision: 0,
    mode: "full_access", operations: [sourceOperation, sinkOperation],
    actionId: "mock-user-grant",
  });
  await studio.publish(draft.automationId, draft.revision);
}

async function runToStatus(fixture: Fixture, automationId: string,
  status: "succeeded" | "completed_with_skips" | "failed") {
  const studio = fixture.application.services.automations!;
  const launched = await studio.runNow(automationId);
  await expect.poll(async () => {
    // Drive real scheduler work without waiting for its wall-clock interval.
    await fixture.scheduler.tick();
    return (await studio.getRun(launched.id)).status;
  }, { timeout: 8_000, interval: 10 }).toBe(status);
  return studio.getRun(launched.id);
}

test.each([
  { ready: false, onFailure: "stop" }, { ready: false, onFailure: "skip" },
  { ready: true, onFailure: "stop" }, { ready: true, onFailure: "skip" },
] as const)("preserves agent output evidence without passing a rejected value downstream: $ready / $onFailure", async ({ ready, onFailure }) => {
  const tools = toolFixture(true);
  const fixture = await createSchedulerRuntimeFixture("execution-agent-v1", undefined, tools.registry);
  fixtures.push(fixture);
  fixture.invoke.mockImplementation(async (input) => {
    if (input.modelStep === "execution.decision") return {
      text: JSON.stringify({ decision: { action: "respond", acknowledgement: "Completed the step." } }), meta: {},
    };
    if (input.modelStep === "execution.response") return {
      text: JSON.stringify({ ready, summary: "Result from the bound source" }), meta: {},
    };
    throw new Error(`unexpected_model_step:${input.modelStep}`);
  });
  const studio = fixture.application.services.automations!;
  let draft = await studio.create("Quality-gated output");
  draft = await addNode(studio, draft, {
    kind: "agent", title: "Check", onFailure,
    modelProfileId: "scheduled-model", agentMode: "reasoning", roleInstructions: "Check the given input.",
    prompt: "Return the declared result.", inputs: { source: { kind: "literal", value: "Evidence" } }, tools: [],
    result: { kind: "json", schema: { type: "object", additionalProperties: false,
      properties: { ready: { type: "boolean" }, summary: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["ready", "summary"] } },
    acceptance: [{ field: "ready", equals: true }],
  });
  const agentId = draft.definition.body.children[0]!.id;
  draft = await addNode(studio, draft, {
    kind: "tool", title: "Save accepted output", onFailure, operation: sinkOperation,
    controls: { label: { kind: "run_file", fileName: "accepted.md" } },
    payload: { kind: "node_result", nodeId: agentId, select: "data", pointer: "/summary" },
  });
  await grantAndPublish(studio, draft);
  const rejectedRunStatus = onFailure === "skip" ? "completed_with_skips" : "failed";
  const run = await runToStatus(fixture, draft.automationId, ready ? "succeeded" : rejectedRunStatus);
  const evidence = await studio.getStepEvidence(run.id, agentId, true);
  const expectedOutput = { ready, summary: "Result from the bound source" };
  expect(evidence.output).toMatchObject({ full: true,
    text: { value: JSON.stringify(expectedOutput), truncated: false },
    data: { value: JSON.stringify(expectedOutput, null, 2), truncated: false } });
  if (!ready) {
    expect(tools.execute).not.toHaveBeenCalled();
    const rejectedNodeStatus = onFailure === "skip" ? "skipped" : "failed";
    expect(evidence.stepStatus).toBe(rejectedNodeStatus);
    expect(run.report?.nodeResults[0]).toMatchObject({ status: rejectedNodeStatus,
      errorCode: "automation_agent_acceptance_failed", resultRef: expect.any(String) });
    expect(run.report?.nodeResults[1]?.status).toBe(onFailure === "skip" ? "skipped" : "cancelled");
    expect(run.report?.nodeResults[1]).not.toHaveProperty("resultRef");
    return;
  }
  expect(tools.execute.mock.calls.map(([call]) => call.params)).toEqual([{
    label: `automation-output/${run.id}/accepted.md`, body: "Result from the bound source",
  }]);
});

test("sends a different run-owned file path to a direct tool on each run", async () => {
  const tools = toolFixture(true);
  const fixture = await createSchedulerRuntimeFixture("execution-agent-v1", undefined, tools.registry);
  fixtures.push(fixture);
  const studio = fixture.application.services.automations!;
  let draft = await studio.create("Per-run output");
  draft = await addNode(studio, draft, {
    kind: "tool", title: "Save", onFailure: "stop", operation: sinkOperation,
    controls: { label: { kind: "run_file", fileName: "brief.md" } },
    payload: { kind: "literal", value: "Verified content" },
  });
  await grantAndPublish(studio, draft);
  const first = await runToStatus(fixture, draft.automationId, "succeeded");
  const second = await runToStatus(fixture, draft.automationId, "succeeded");
  expect(first.id).not.toBe(second.id);
  expect(tools.execute.mock.calls.map(([call]) => call.params)).toEqual([first, second].map((run) => ({
    label: `automation-output/${run.id}/brief.md`, body: "Verified content",
  })));
  expect(fixture.invoke).not.toHaveBeenCalled();
});

test.each([false, 0, null])("retains a tool's present %j structured output through the model handoff", async (data) => {
  const tools = toolFixture(true);
  tools.execute.mockImplementation(async (call) => ({ ok: true, tool: call.tool,
    output: "Observed", producedNewInformation: true, data: { value: data } }));
  const fixture = await createSchedulerRuntimeFixture("execution-agent-v1", undefined, tools.registry);
  fixtures.push(fixture);
  const observed = scriptModel(fixture);
  const studio = fixture.application.services.automations!;
  let draft = await studio.create("Structured value");
  draft = await addNode(studio, draft, {
    kind: "tool", title: "Read", onFailure: "stop", operation: sourceOperation,
    controls: { key: { kind: "literal", value: "value" } },
  });
  const sourceId = draft.definition.body.children[0]!.id;
  draft = await addNode(studio, draft, {
    kind: "agent", title: "Use value", onFailure: "stop",
    modelProfileId: "scheduled-model", agentMode: "reasoning", roleInstructions: "Use the bound value.",
    prompt: "Produce a result.", inputs: { source: { kind: "node_result", nodeId: sourceId, select: "data", pointer: "/value" } },
    tools: [], result: { kind: "text" },
  });
  await grantAndPublish(studio, draft);
  await runToStatus(fixture, draft.automationId, "succeeded");
  expect(observed).toHaveLength(2);
  expect(observed.every((call) => call.inputs.source === data)).toBe(true);
});

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s materializes only serial branch tail output text and data in the downstream agent context",
  async (policy: Policy) => {
    const tools = toolFixture(true);
    const fixture = await createSchedulerRuntimeFixture(policy, undefined, tools.registry);
    fixtures.push(fixture);
    const observed = scriptModel(fixture);
    const studio = fixture.application.services.automations!;
    let draft = await studio.create("Parallel handoff");
    for (const title of ["First source", "Second source"]) {
      draft = await addNode(studio, draft, {
        kind: "tool", title, onFailure: "stop", operation: sourceOperation,
        controls: { key: { kind: "literal", value: title } },
      });
    }
    const sourceIds = draft.definition.body.children.map((node) => node.id);
    draft = await studio.updateDraft(draft.automationId, draft.revision, {
      kind: "wrap_parallel", nodeIds: sourceIds,
    });
    const parallel = draft.definition.body.children[0]!;
    if (parallel.kind !== "parallel") throw new Error("expected_parallel_group");
    const parallelNodeId = parallel.id;
    for (const branch of parallel.branches) {
      draft = await studio.updateDraft(draft.automationId, draft.revision, {
        kind: "add_node", parentSequenceId: branch.id, index: 0,
        nodeWithoutId: { kind: "tool", title: "Intermediate source", onFailure: "stop",
          operation: sourceOperation, controls: { key: { kind: "literal", value: "intermediate" } } },
      });
    }
    draft = await addNode(studio, draft, {
      kind: "agent", title: "Combine", onFailure: "stop",
      modelProfileId: "scheduled-model", agentMode: "reasoning",
      roleInstructions: "Combine the selected results.", prompt: "Produce a result.",
      inputs: { source: { kind: "branch_results", parallelNodeId } },
      tools: [], result: { kind: "text" },
    });
    await grantAndPublish(studio, draft);

    await runToStatus(fixture, draft.automationId, "succeeded");
    expect(observed).toHaveLength(2);
    for (const call of observed) {
      expect(call.inputs.source).toEqual(sourceIds.map((nodeId) => ({
        nodeId, status: "succeeded", resultRef: expect.any(String),
        text: `Observed ${invoiceId}`, data: { invoiceId },
      })));
    }
    expect(tools.execute).toHaveBeenCalledTimes(4);
  },
);

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s carries an explicitly bound tool output through model context into exact tool controls and payload",
  async (policy: Policy) => {
    const tools = toolFixture(true);
    const fixture = await createSchedulerRuntimeFixture(policy, undefined, tools.registry);
    fixtures.push(fixture);
    const observed = scriptModel(fixture);
    const studio = fixture.application.services.automations!;
    let draft = await studio.create("Bound handoff");
    draft = await addNode(studio, draft, {
      kind: "tool", title: "Read", onFailure: "stop", operation: sourceOperation,
      controls: { key: { kind: "literal", value: "invoice" } },
    });
    const sourceId = draft.definition.body.children.at(-1)!.id;
    draft = await addNode(studio, draft, {
      kind: "agent", title: "Transform", onFailure: "stop",
      modelProfileId: "scheduled-model", agentMode: "reasoning",
      roleInstructions: "Transform the bound value.", prompt: "Produce a result.",
      inputs: { source: { kind: "node_result", nodeId: sourceId,
        select: "data", pointer: "/invoiceId" } },
      tools: [], result: { kind: "text" },
    });
    const agentId = draft.definition.body.children.at(-1)!.id;
    draft = await addNode(studio, draft, {
      kind: "tool", title: "Record", onFailure: "stop", operation: sinkOperation,
      controls: { label: { kind: "node_result", nodeId: sourceId,
        select: "data", pointer: "/invoiceId" } },
      payload: { kind: "node_result", nodeId: agentId, select: "text" },
    });
    draft = await addNode(studio, draft, {
      kind: "agent", title: "Independent", onFailure: "stop",
      modelProfileId: "scheduled-model", agentMode: "reasoning",
      roleInstructions: "Return an independent result.", prompt: "Produce a result.",
      inputs: {}, tools: [], result: { kind: "text" },
    });
    await grantAndPublish(studio, draft);

    const run = await runToStatus(fixture, draft.automationId, "succeeded");
    expect(run.report?.nodeResults.map((node) => node.status))
      .toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    expect(tools.execute.mock.calls.map(([call]) => call)).toEqual([
      { tool: sourceOperation.toolName, params: { key: "invoice" } },
      { tool: sinkOperation.toolName,
        params: { label: invoiceId, body: `processed:${invoiceId}` } },
    ]);
    expect(observed.filter((item) => item.inputs.source === invoiceId)).toHaveLength(2);
    const independent = observed.filter((item) => Object.keys(item.inputs).length === 0);
    expect(independent).toHaveLength(2);
    expect(independent.every((item) => !item.content.includes(invoiceId))).toBe(true);
  },
);

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s blocks dependent model and tool calls after a skipped producer while an unbound agent continues",
  async (policy: Policy) => {
    const tools = toolFixture(false);
    const fixture = await createSchedulerRuntimeFixture(policy, undefined, tools.registry);
    fixtures.push(fixture);
    const observed = scriptModel(fixture);
    const studio = fixture.application.services.automations!;
    let draft = await studio.create("Failed source handoff");
    draft = await addNode(studio, draft, {
      kind: "tool", title: "Unavailable source", onFailure: "skip", operation: sourceOperation,
      controls: { key: { kind: "literal", value: "invoice" } },
    });
    const sourceId = draft.definition.body.children.at(-1)!.id;
    draft = await addNode(studio, draft, {
      kind: "agent", title: "Dependent agent", onFailure: "skip",
      modelProfileId: "scheduled-model", agentMode: "reasoning",
      roleInstructions: "Use the bound input.", prompt: "Produce a result.",
      inputs: { source: { kind: "node_result", nodeId: sourceId, select: "text" } },
      tools: [], result: { kind: "text" },
    });
    const dependentId = draft.definition.body.children.at(-1)!.id;
    draft = await addNode(studio, draft, {
      kind: "tool", title: "Dependent tool", onFailure: "skip", operation: sinkOperation,
      controls: { label: { kind: "literal", value: "invoice" } },
      payload: { kind: "node_result", nodeId: dependentId, select: "text" },
    });
    draft = await addNode(studio, draft, {
      kind: "agent", title: "Independent", onFailure: "stop",
      modelProfileId: "scheduled-model", agentMode: "reasoning",
      roleInstructions: "Return an independent result.", prompt: "Produce a result.",
      inputs: {}, tools: [], result: { kind: "text" },
    });
    await grantAndPublish(studio, draft);

    const run = await runToStatus(fixture, draft.automationId, "completed_with_skips");
    expect(run.report?.nodeResults.map((node) => node.status))
      .toEqual(["skipped", "skipped", "skipped", "succeeded"]);
    expect(tools.execute.mock.calls.map(([call]) => call.tool))
      .toEqual([sourceOperation.toolName]);
    expect(observed).toHaveLength(2);
    expect(observed.every((item) => Object.keys(item.inputs).length === 0)).toBe(true);
  },
);
