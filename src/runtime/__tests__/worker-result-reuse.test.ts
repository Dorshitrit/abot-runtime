import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { projectLlamaCppFormat } from "../../model-gateway/providers/llamacpp/schema-format.js";
import { MODEL_STEPS } from "../../shared/model-steps.js";
import { bindRequestToolResultsMessage } from "../context/request-tool-results-message-binding.js";
import { buildRequestToolResultsMessage, REQUEST_TOOL_RESULTS_MESSAGE_KIND } from "../context/request-tool-results.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import type { ModelGatewayClient } from "../ports.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { SUPERVISOR_WORKER_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { runWorkerDecision } from "../steps/worker-decision/run.js";
import { buildWorkerDecisionInput } from "../steps/worker-decision/input.js";
import { acceptWorkerEvidenceAssessment, prepareWorkerEvidenceAssessment } from "../steps/worker-decision/evidence-assessment.js";
import { runWorkerResultAuthor } from "../steps/worker-decision/result-author.js";
import * as workerHandoffCompaction from "../steps/worker-decision/worker-handoff-compaction.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { createSuperCompactionSourceFixture } from "./support/super-compaction-source.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { vi.restoreAllMocks(); resetDebugLoggerConfig(); });

async function fixture() {
  const source = await createSuperCompactionSourceFixture("worker-result-reuse");
  const invoke = vi.fn<ModelGatewayClient["invoke"]>();
  const capabilities = Object.freeze([Object.freeze({
    capabilityId: "example.catalog", summary: "Read the requested catalog.",
    effect: "observation" as const, catalogGroups: ["read"] as const,
    controls: { type: "object" as const, additionalProperties: false as const,
      properties: {}, required: [] },
  })]);
  const request = createTestRequestExecutionScope({
    ...source.request,
    runnerConfig: { ...source.request.runnerConfig, steps: {
      ...source.request.runnerConfig.steps,
      [MODEL_STEPS.WORKER_DECISION]: { timeoutMs: 20_000 },
      [MODEL_STEPS.WORKER_RESULT]: { timeoutMs: 20_000 },
    } },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    workerCapabilityProvider: {
      getDescriptors: () => capabilities, getAdapters: () => [],
    },
  }, { executionPolicy: SUPERVISOR_WORKER_V1_EXECUTION_POLICY });
  const options = {
    call: source.call, requestToolResults: source.view,
    capabilitySource: {
      ledger: source.ledger, head: source.head,
      binding: Object.freeze({ requestId: request.requestId, ledger: source.ledger,
        callId: source.call.callId, invocationAttempt: source.call.activationCount, capabilities }),
    },
  };
  const result = source.view.results[0]!;
  return { request, options, invoke, result };
}

function readyOutput(evidenceRefs: readonly string[]) {
  return JSON.stringify({ decision: {
    assessment: { requiresExecution: false, established: "The catalog was read.", remaining: "", evidenceRefs },
    selection: { action: "return_result" },
  } });
}

test("ready evidence automatically produces a factual report after one Worker decision", async () => {
  const f = await fixture();
  f.invoke.mockImplementation(async (input) => {
    expect(input.modelStep).toBe(MODEL_STEPS.WORKER_DECISION);
    expect(input.format).toMatchObject({ name: "worker_evidence_and_selection" });
    const text = readyOutput([f.result.executionId]);
    const value = JSON.parse(text);
    const wire = projectLlamaCppFormat(input.format) as { json_schema: { schema: Record<string, unknown> } };
    expect(validateJsonSchemaValue(wire.json_schema.schema, value)).toBeUndefined();
    const executingAssessment = { ...value.decision.assessment, requiresExecution: true, remaining: "Read the missing range." };
    expect(validateJsonSchemaValue(wire.json_schema.schema, {
      decision: { assessment: executingAssessment, selection: value.decision.selection },
    })).toBeDefined();
    expect(validateJsonSchemaValue(wire.json_schema.schema, {
      decision: { ...value.decision, selection: { ...value.decision.selection,
        resultSourceExecutionId: f.result.executionId } },
    })).toBeDefined();
    return { text, meta: {} };
  });

  const decision = await runWorkerDecision(f.request, f.options);
  expect(decision.action).toBe("return_result");
  if (decision.action !== "return_result") throw new Error("expected Worker report");
  const report = JSON.parse(decision.result);
  expect(report).toMatchObject({
    kind: "runtime_worker_execution_report_v1", authority: "reference_data",
    callId: f.options.call.callId,
    sourceRevision: f.options.requestToolResults.sourceRevision,
    assessment: { authority: "accepted_model_judgment", requiresExecution: false,
      established: "The catalog was read.", evidenceRefs: [f.result.executionId] },
  });
  expect(report.executionOutcomes).toEqual([expect.objectContaining({
    executionId: f.result.executionId, outcome: f.result.outcome, observedEffect: f.result.observedEffect,
  })]);
  expect(report.evidence.requestToolResults.results).toEqual([expect.objectContaining({
    executionId: f.result.executionId, summary: f.result.summary, adapterResult: f.result.adapterResult,
  })]);
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([MODEL_STEPS.WORKER_DECISION]);
  expect(f.request.modelGatewayClient.invokeRaw).not.toHaveBeenCalled();
});

test("a late projection hiding source text does not rehydrate it or fall back to RAW", async () => {
  const f = await fixture();
  const completeHandoff = workerHandoffCompaction.completeWorkerHandoffEvidence;
  const projection = vi.spyOn(workerHandoffCompaction, "completeWorkerHandoffEvidence")
    .mockImplementation(async (...args) => {
      const source = await completeHandoff(...args);
      return Object.freeze({ ...source,
        requestToolResultsContextMessage: bindRequestToolResultsMessage(source.requestToolResults,
          JSON.stringify({ kind: REQUEST_TOOL_RESULTS_MESSAGE_KIND,
            sourceRevision: source.requestToolResults.sourceRevision, results: [] })),
      });
    });
  f.invoke.mockImplementation(async (input) => {
    expect(input.modelStep).toBe(MODEL_STEPS.WORKER_DECISION);
    return { text: readyOutput([f.result.executionId]), meta: {} };
  });

  const decision = await runWorkerDecision(f.request, f.options);
  expect(decision.action).toBe("return_result");
  if (decision.action !== "return_result") throw new Error("expected Worker report");
  expect(JSON.parse(decision.result).evidence.requestToolResults.results).toEqual([]);
  expect(decision.result).not.toContain(f.result.referenceData);
  expect(projection).toHaveBeenCalledOnce();
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([MODEL_STEPS.WORKER_DECISION]);
  expect(f.request.modelGatewayClient.invokeRaw).not.toHaveBeenCalled();
});

test.each([false, true])("foreign execution affects report selection only when used by the assessment (cited=%s)", async (cited) => {
  const f = await fixture();
  const input = buildWorkerDecisionInput(f.request, f.options);
  const view = Object.freeze({ sourceRevision: f.options.requestToolResults.sourceRevision,
    results: Object.freeze([Object.freeze({ ...f.result, callId: "earlier-call" })]) });
  const source = Object.freeze({ ...input.resultAuthorSource, requestToolResults: view,
    requestToolResultsContextMessage: buildRequestToolResultsMessage(view) });
  const contexts = Object.freeze([source.requestToolResultsContextMessage]);
  const prepared = prepareWorkerEvidenceAssessment(f.request, { call: f.options.call, source, contextMessages: contexts });
  const evidenceAssessment = acceptWorkerEvidenceAssessment(f.request, prepared, Object.freeze({
    requiresExecution: false, established: "The assigned content is ready to present.", remaining: "",
    evidenceRefs: Object.freeze(cited ? [f.result.executionId] : []),
  }));
  f.invoke.mockImplementation(async (invocation) => {
    expect(invocation.modelStep).toBe(MODEL_STEPS.WORKER_RESULT);
    return { text: "Original assigned content.", meta: {} };
  });
  const result = await runWorkerResultAuthor(f.request, { diagnostic: input.diagnostic, source, evidenceAssessment });
  if (cited) {
    expect(JSON.parse(result).executionOutcomes).toEqual([]);
    expect(result).toContain(f.result.summary);
    expect(f.invoke).not.toHaveBeenCalled();
    return;
  }
  expect(result).toBe("Original assigned content.");
  expect(f.invoke.mock.calls.map(([invocation]) => invocation.modelStep)).toEqual([MODEL_STEPS.WORKER_RESULT]);
});
