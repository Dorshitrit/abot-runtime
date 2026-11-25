import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { MODEL_STEPS } from "../../shared/model-steps.js";
import type { ModelGatewayClient } from "../ports.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { SUPERVISOR_WORKER_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { runWorkerDecision } from "../steps/worker-decision/run.js";
import { buildWorkerDecisionInput } from "../steps/worker-decision/input.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { createSuperCompactionSourceFixture } from "./support/super-compaction-source.js";

const ESTABLISHED = "The first catalog window was observed.";
const RAW_CONTEXT_MARKER = "RAW_EVIDENCE_CONTEXT_MUST_SURVIVE.txt";
const REMAINING = "Observe the remaining requested range.";
const descriptor = Object.freeze({
  capabilityId: "example.observe",
  summary: "Observe one requested range.",
  effect: "observation" as const,
  catalogGroups: Object.freeze(["read"] as const),
  controls: {
    type: "object" as const,
    additionalProperties: false as const,
    properties: { start: { type: "integer" as const, minimum: 0, maximum: 100_000 } },
    required: ["start"],
  },
});

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function assessment(requiresExecution: boolean) {
  return {
    requiresExecution,
    established: ESTABLISHED,
    remaining: requiresExecution ? REMAINING : "",
    evidenceRefs: ["capability-execution-1"],
  };
}

function decision(value: unknown) {
  return { text: JSON.stringify({ decision: value }), meta: {} };
}

async function fixture(capabilitiesAvailable = true) {
  const base = await createSuperCompactionSourceFixture("worker-evidence-request", RAW_CONTEXT_MARKER);
  const invoke = vi.fn<ModelGatewayClient["invoke"]>();
  const capabilities = Object.freeze(capabilitiesAvailable ? [descriptor] : []);
  const request = createTestRequestExecutionScope({
    ...base.request,
    runnerConfig: {
      ...base.request.runnerConfig,
      steps: {
        ...base.request.runnerConfig.steps,
        [MODEL_STEPS.WORKER_DECISION]: { timeoutMs: 20_000 },
        [MODEL_STEPS.CAPABILITY_CONTROLS]: { timeoutMs: 20_000 },
        [MODEL_STEPS.WORKER_RESULT]: { timeoutMs: 20_000 },
      },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    workerCapabilityProvider: {
      getDescriptors: () => capabilities,
      getAdapters: () => [],
      getExecutionGuidance: async () => "Provide the start of the remaining range.",
    },
  }, { executionPolicy: SUPERVISOR_WORKER_V1_EXECUTION_POLICY });
  const options = {
    call: base.call,
    requestToolResults: base.view,
    capabilitySource: {
      ledger: base.ledger,
      head: base.head,
      binding: Object.freeze({
        requestId: request.requestId,
        ledger: base.ledger,
        callId: base.call.callId,
        invocationAttempt: base.call.activationCount,
        capabilities,
      }),
    },
  };
  return { ...base, request, invoke, options };
}

function originalMessages(f: Awaited<ReturnType<typeof fixture>>) {
  const messages = buildWorkerDecisionInput(f.request, f.options).context.messages
    .filter(({ role }) => role !== "system");
  expect(JSON.stringify(messages)).toContain(RAW_CONTEXT_MARKER);
  expect(JSON.stringify(messages)).toContain(descriptor.capabilityId);
  expect(messages.some(({ content }) => content.includes('"kind":"runtime_worker_assignment"'))).toBe(true);
  return messages;
}

function expectSharedContext(
  input: Parameters<ModelGatewayClient["invoke"]>[0],
  original: readonly ChatMessage[],
) {
  const messages = input.messages as readonly ChatMessage[];
  const preserved = messages.filter((message) => original.some((base) =>
    base.role === message.role && base.content === message.content));
  expect(preserved).toEqual(original);
  expect(JSON.stringify(messages)).toContain(RAW_CONTEXT_MARKER);
  expect(JSON.stringify(messages)).toContain("Complete catalog evidence.");
}

test("assesses evidence with selection once before refining execution for the remaining work", async () => {
  const f = await fixture();
  const original = originalMessages(f);
  f.invoke.mockImplementation(async (input) => {
    expectSharedContext(input, original);
    if (input.modelStep === MODEL_STEPS.WORKER_DECISION) {
      expect(input.format).toMatchObject({ name: "worker_evidence_and_selection" });
      return decision({ assessment: assessment(true), selection: {
        action: "invoke_capability", capabilityId: descriptor.capabilityId,
        intent: "Observe the remaining range.",
      } });
    }
    expect(input.modelStep).toBe(MODEL_STEPS.CAPABILITY_CONTROLS);
    expect(JSON.stringify(input.messages)).toContain(REMAINING);
    return decision({ action: "invoke_capability", controls: { start: 10_000 } });
  });

  await expect(runWorkerDecision(f.request, f.options)).resolves.toMatchObject({
    action: "invoke_capability", capabilityId: descriptor.capabilityId,
    controls: { start: 10_000 },
  });
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    MODEL_STEPS.WORKER_DECISION, MODEL_STEPS.CAPABILITY_CONTROLS,
  ]);
});

test("reports a ready assessment and canonical evidence without another model call", async () => {
  const f = await fixture();
  const original = originalMessages(f);
  f.invoke.mockImplementation(async (input) => {
    expectSharedContext(input, original);
    expect(input.modelStep).toBe(MODEL_STEPS.WORKER_DECISION);
    return decision({ assessment: assessment(false), selection: { action: "return_result" } });
  });

  const result = await runWorkerDecision(f.request, f.options);
  expect(result.action).toBe("return_result");
  if (result.action !== "return_result") throw new Error("expected Worker report");
  const report = JSON.parse(result.result);
  expect(report.assessment).toEqual({ authority: "accepted_model_judgment", ...assessment(false) });
  expect(report.callId).toBe(f.call.callId);
  expect(report.evidence.requestToolResults.results).toEqual([expect.objectContaining({
    executionId: "capability-execution-1",
    adapterResult: expect.objectContaining({ payload: { referenceData: "Complete catalog evidence." } }),
  })]);
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([MODEL_STEPS.WORKER_DECISION]);
  expect(f.request.modelGatewayClient.invokeRaw).not.toHaveBeenCalled();
});

test("rejects an assessment whose canonical evidence head changed before downstream use", async () => {
  const f = await fixture();
  f.invoke.mockImplementation(async (input) => {
    expect(input.modelStep).toBe(MODEL_STEPS.WORKER_DECISION);
    await f.commit({
      authority: "active_role", type: "begin_capability_execution",
      callId: f.call.callId, invocationAttempt: f.call.activationCount,
      capabilityId: descriptor.capabilityId, declaredEffect: "observation",
      intent: "Observe a newly available range.", controlsJson: '{"start":10000}',
    });
    return decision({ assessment: assessment(false), selection: { action: "return_result" } });
  });

  await expect(runWorkerDecision(f.request, f.options)).rejects.toThrow("worker_evidence_canonical_context_stale");
  expect(f.ledger.current()).not.toBe(f.head);
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    MODEL_STEPS.WORKER_DECISION,
  ]);
});

test("returns an unavailable-capability failure without authoring a result for missing evidence", async () => {
  const f = await fixture(false);
  f.invoke.mockImplementation(async (input) => {
    expect(input.modelStep).toBe(MODEL_STEPS.WORKER_DECISION);
    return decision({ assessment: assessment(true), selection: {
      action: "return_failure", reason: "No capability can observe the remaining range.",
    } });
  });

  await expect(runWorkerDecision(f.request, f.options)).resolves.toEqual({
    action: "return_failure", reason: "No capability can observe the remaining range.",
  });
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    MODEL_STEPS.WORKER_DECISION,
  ]);
});
