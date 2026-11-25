import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { MODEL_STEPS } from "../../shared/model-steps.js";
import type { ModelGatewayClient } from "../ports.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { SUPERVISOR_WORKER_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { runWorkerDecision } from "../steps/worker-decision/run.js";
import { WORKER_OUTPUT_TYPE_NOTATION } from "../steps/worker-decision/fused-output-contract.js";
import { isInvocationContextMessage } from "../../model-gateway/protocol/invocation-context.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { createSuperCompactionSourceFixture } from "./support/super-compaction-source.js";

const RAW_EVIDENCE = "EXACT_RANGE_EVIDENCE.txt";
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
    established: "The first catalog window was observed.",
    remaining: requiresExecution ? "Observe the remaining requested range." : "",
    evidenceRefs: ["capability-execution-1"],
  };
}

function output(value: unknown) {
  return { text: JSON.stringify({ decision: value }), meta: {} };
}

async function fixture() {
  const base = await createSuperCompactionSourceFixture("worker-fusion-request", RAW_EVIDENCE);
  const invoke = vi.fn<ModelGatewayClient["invoke"]>();
  const capabilities = Object.freeze([descriptor]);
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
        requestId: request.requestId, ledger: base.ledger,
        callId: base.call.callId, invocationAttempt: base.call.activationCount,
        capabilities,
      }),
    },
  };
  return { request, invoke, options };
}

test("default SUPER assesses evidence and selects once, then discloses controls separately", async () => {
  const f = await fixture();
  f.invoke.mockImplementation(async (input) => {
    expect(JSON.stringify(input.messages)).toContain(RAW_EVIDENCE);
    if (input.modelStep === MODEL_STEPS.WORKER_DECISION) {
      expect(input.format).toMatchObject({ name: "worker_evidence_and_selection" });
      const messages = input.messages as readonly ChatMessage[];
      const contract = messages.at(-1)!;
      expect(messages.filter(({ content }) => content.includes(WORKER_OUTPUT_TYPE_NOTATION))).toEqual([contract]);
      expect(contract.role).toBe("system");
      expect(isInvocationContextMessage(contract)).toBe(true);
      expect(isInvocationContextMessage({ ...contract })).toBe(false);
      expect(messages[0]?.role).toBe("system");
      expect(messages[0]?.content).not.toContain(WORKER_OUTPUT_TYPE_NOTATION);
      expect(messages[0]?.content).not.toContain('"capability-execution-1"');
      expect(contract.content).toContain('assessment:');
      expect(contract.content).toContain('selection:');
      expect(contract.content).toContain('evidenceRefs:Array<"capability-execution-1">[0..1] unique');
      expect(contract.content).toContain('"invoke_capability"');
      expect(contract.content).not.toContain('"start"');
      const preceding = messages.slice(1, -1);
      expect(preceding.some(({ content }) => content.includes(RAW_EVIDENCE))).toBe(true);
      expect(preceding.some(({ content }) => content.includes('"kind":"runtime_worker_evidence_assignment_v1"'))).toBe(true);
      return output({ assessment: assessment(true), selection: {
        action: "invoke_capability", capabilityId: descriptor.capabilityId,
        intent: "Observe the remaining range.",
      } });
    }
    expect(input.modelStep).toBe(MODEL_STEPS.CAPABILITY_CONTROLS);
    expect(JSON.stringify(input.messages)).toContain("Observe the remaining requested range.");
    return output({ action: "invoke_capability", controls: { start: 10_000 } });
  });

  await expect(runWorkerDecision(f.request, f.options)).resolves.toMatchObject({
    action: "invoke_capability", capabilityId: descriptor.capabilityId,
    controls: { start: 10_000 },
  });
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    MODEL_STEPS.WORKER_DECISION, MODEL_STEPS.CAPABILITY_CONTROLS,
  ]);
});

test("default SUPER ready evidence returns a factual report without another model call", async () => {
  const f = await fixture();
  f.invoke.mockImplementation(async (input) => {
    expect(JSON.stringify(input.messages)).toContain(RAW_EVIDENCE);
    expect(input.modelStep).toBe(MODEL_STEPS.WORKER_DECISION);
    return output({ assessment: assessment(false), selection: { action: "return_result" } });
  });

  const result = await runWorkerDecision(f.request, f.options);
  expect(result.action).toBe("return_result");
  if (result.action !== "return_result") throw new Error("expected_report");
  expect(JSON.parse(result.result)).toMatchObject({
    kind: "runtime_worker_execution_report_v1",
    assessment: { established: assessment(false).established },
  });
  expect(result.result).toContain(RAW_EVIDENCE);
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    MODEL_STEPS.WORKER_DECISION,
  ]);
});
