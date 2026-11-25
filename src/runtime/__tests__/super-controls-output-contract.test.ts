import { expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createRoleCallLedger } from "../orchestration/role-calls/index.js";
import { createWorkerCapabilityBinding, type WorkerCapabilityDescriptor } from "../orchestration/worker-capabilities/index.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { buildWorkerDecisionInput } from "../steps/worker-decision/input.js";
import { projectSuperWorkerControlsOutputContract } from "../steps/worker-decision/input/controls-output-contract.js";
import { prepareWorkerDecisionSession } from "../steps/worker-decision/input/session.js";
import type { WorkerDecisionInputRequest } from "../steps/worker-decision/input/types.js";
import { parseWorkerDecisionOutput } from "../steps/worker-decision/parser.js";
import { createWorkerDecisionModelPolicy, createWorkerDecisionRunnerConfig } from "./support/worker-decision-model-fixture.js";

const inspect: WorkerCapabilityDescriptor = {
  capabilityId: "fixture.inspect", summary: "Inspect the selected source.", effect: "observation",
  selectionControlIds: ["path"],
  controls: { type: "object", additionalProperties: false, properties: {
    path: { type: "string", minLength: 1, maxLength: 64 },
    query: { type: "string", minLength: 1, maxLength: 64 },
    maxItems: { type: "integer", minimum: 1, maximum: 20 },
  }, required: ["path"] },
};
const count: WorkerCapabilityDescriptor = {
  capabilityId: "fixture.count", summary: "Count the available sources.", effect: "observation",
  controls: { type: "object", additionalProperties: false, properties: {}, required: [] },
};
const selection = { capabilityId: inspect.capabilityId, intent: "Inspect the source.", selectionControls: { path: "first.txt" }, guidance: "" };
const countSelection = { capabilityId: count.capabilityId, intent: "Count sources.", guidance: "" };

async function fixture() {
  const request: WorkerDecisionInputRequest = {
    requestId: "super-controls-output", prompt: "Inspect the selected source.", historyMessages: [], agentMode: "reasoning",
    runnerConfig: createWorkerDecisionRunnerConfig(),
    modelPolicy: createWorkerDecisionModelPolicy(32_000, true),
  };
  const ledger = createRoleCallLedger({ requestId: request.requestId, policy: { limits: {
    maxDepth: 4, maxCalls: 8, maxCapabilityExecutions: 8,
    maxObjectiveChars: 4096, maxResultChars: 8192, maxResponseChars: 8192,
  } } });
  const root = await ledger.apply({ expectedHead: ledger.current(), command: { authority: "runtime", type: "create_root" } });
  if (!root.ok) throw new Error(root.code);
  const child = await ledger.apply({ expectedHead: ledger.current(), command: {
    authority: "active_role", type: "open_child", callerCallId: "call-1", roleId: "worker", objective: request.prompt,
  } });
  if (!child.ok) throw new Error(child.code);
  const head = ledger.current();
  const call = head.state.calls.find(({ callId }) => callId === head.state.activeCallId)!;
  const binding = createWorkerCapabilityBinding({ requestId: request.requestId, ledger, call, context: {},
    adapters: [inspect, count].map((descriptor) => ({ descriptor, execute: async () => { throw new Error("unexpected_execution"); } })),
  });
  return { request, options: { call, requestToolResults: { sourceRevision: 0, results: [] }, capabilitySource: { ledger, head, binding } } };
}

function outputReference(messages: readonly ChatMessage[]) {
  for (const { content } of messages) {
    for (const line of content.split("\n")) {
      if (!line.startsWith('{"kind":"runtime_worker_controls_output_contract_v1"')) continue;
      return JSON.parse(line);
    }
  }
  return undefined;
}

function parseControls(input: ReturnType<typeof buildWorkerDecisionInput>, decision: Record<string, unknown>) {
  return parseWorkerDecisionOutput(JSON.stringify({ decision }), undefined, {
    availableCapabilities: input.availableCapabilities, decisionPhase: "capability_execution",
    pendingCapabilitySelection: input.pendingCapabilitySelection,
    pendingCapabilityBatchSelection: input.pendingCapabilityBatchSelection,
    maxBatchCapabilityExecutions: input.maxBatchCapabilityExecutions,
  });
}

test("SUPER exposes the exact selected output contract without configuration or shared evidence changes", async () => {
  const f = await fixture();
  const options = { ...f.options, selectedCapabilityExecution: selection };
  const selected = buildWorkerDecisionInput(f.request, options);
  expect(outputReference(selected.context.messages)).toMatchObject({
    authority: "current_model_output_contract", applicability: "this_controls_refinement_only",
    outputType: expect.stringContaining('controls:{query:(string[1..64]|null),maxItems:(integer{"minimum":1,"maximum":20}|null)}'),
  });
  expect(outputReference(selected.sharedContextMessages)).toBeUndefined();
  expect(JSON.stringify(outputReference(selected.context.messages))).not.toContain(count.capabilityId);
  expect(parseControls(selected, { action: "return_failure", reason: "A required user decision is unresolved." }))
    .toMatchObject({ ok: true, decision: { action: "return_failure" } });
});

test("unset optional controls and an empty controls object still invoke the frozen selection", async () => {
  const f = await fixture();
  const input = buildWorkerDecisionInput(f.request, { ...f.options, selectedCapabilityExecution: selection });
  for (const controls of [{}, { query: null, maxItems: null }]) {
    expect(parseControls(input, { action: "invoke_capability", controls }))
      .toMatchObject({ ok: true, decision: { action: "invoke_capability", capabilityId: inspect.capabilityId,
        controls: { path: "first.txt" } } });
  }
  expect(parseControls(input, { action: "invoke_capability", controls: { path: "replacement.txt" } })).toMatchObject({ ok: false });
  const empty = buildWorkerDecisionInput(f.request, { ...f.options, selectedCapabilityExecution: countSelection });
  expect(outputReference(empty.context.messages).outputType).toContain('action:"invoke_capability",controls:{}');
  expect(parseControls(empty, { action: "invoke_capability", controls: {} }))
    .toMatchObject({ ok: true, decision: { capabilityId: count.capabilityId, controls: {} } });
});

test("batch output preserves heterogeneous and repeated selections through exact invocation slots", async () => {
  const f = await fixture();
  const invocations = [selection, countSelection, { ...selection, selectionControls: { path: "last.txt" } }];
  const input = buildWorkerDecisionInput(f.request, { ...f.options, selectedCapabilityBatchExecution: { invocations } });
  const outputType = outputReference(input.context.messages).outputType;
  const schema = input.format.schema as { properties: { decision: { anyOf: Array<{ properties: { action: { enum: string[] }; invocations: { properties: Record<string, unknown> } } }> } } };
  const variants = schema.properties.decision.anyOf;
  const batch = variants.find((variant: { properties: { action: { enum: string[] } } }) => variant.properties.action.enum.includes("invoke_capabilities"));
  if (!batch) throw new Error("batch output schema missing");
  expect(Object.keys(batch.properties.invocations.properties)).toEqual(["invocation_1", "invocation_2", "invocation_3"]);
  expect(outputType).toContain('invocation_1:{controls:{query:(string[1..64]|null)');
  expect(outputType).toContain('invocation_2:{controls:{}}');
  expect(outputType).toContain('invocation_3:{controls:{query:(string[1..64]|null)');
  expect(parseControls(input, { action: "invoke_capabilities", invocations: {
    invocation_1: { controls: { query: null, maxItems: 5 } },
    invocation_2: { controls: {} },
    invocation_3: { controls: { query: "last", maxItems: null } },
  } })).toMatchObject({ ok: true, decision: { invocations: [
    { capabilityId: inspect.capabilityId, controls: { path: "first.txt", maxItems: 5 } },
    { capabilityId: count.capabilityId, controls: {} },
    { capabilityId: inspect.capabilityId, controls: { path: "last.txt", query: "last" } },
  ] } });
});

test("controls output contract is absent during selection and for non-SUPER authority", async () => {
  const f = await fixture();
  expect(outputReference(buildWorkerDecisionInput(f.request, f.options).context.messages)).toBeUndefined();
  const session = prepareWorkerDecisionSession(f.request, { ...f.options, selectedCapabilityExecution: selection });
  const source = session.canonicalState.canonicalSource!;
  expect(projectSuperWorkerControlsOutputContract({ ...session, canonicalState: { ...session.canonicalState,
    canonicalSource: { ...source, head: { ...source.head, policy: { ...source.head.policy,
      authority: EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
    } } },
  } })).toBeUndefined();
});
