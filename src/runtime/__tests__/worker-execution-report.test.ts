import { expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { bindOperationSupervisionEvidenceMessage, rebindOperationSupervisionEvidenceMessage } from "../context/operation-supervision-evidence-binding.js";
import { bindRequestToolResultsMessage } from "../context/request-tool-results-message-binding.js";
import { REQUEST_TOOL_RESULTS_MESSAGE_KIND, type RequestToolResult } from "../context/request-tool-results.js";
import type { WorkerResultAuthorSource } from "../steps/worker-decision/contracts.js";
import type { WorkerEvidenceAssessmentReceipt } from "../steps/worker-decision/evidence-assessment.js";
import { buildWorkerExecutionReport } from "../steps/worker-decision/execution-report.js";
import { createSuperCompactionSourceFixture } from "./support/super-compaction-source.js";

function message(value: unknown): ChatMessage {
  return Object.freeze({ role: "user", content: JSON.stringify(value) });
}

function result(overrides: Partial<RequestToolResult> = {}): RequestToolResult {
  return Object.freeze({ executionId: "execution-1", callId: "worker-1", invocationAttempt: 1,
    capabilityId: "example.read", declaredEffect: "observation", outcome: "succeeded",
    observedEffect: "observation", summary: "Exact observation.", ...overrides });
}

function source(results: readonly RequestToolResult[] = [], visible: readonly unknown[] = results,
  extras: Record<string, unknown> = {}): WorkerResultAuthorSource {
  const view = Object.freeze({ sourceRevision: 7, results: Object.freeze([...results]) });
  return Object.freeze({ callId: "worker-1", parentCallId: "root-1", depth: 1, invocationAttempt: 2,
    objective: "Objective is not transferred as evidence.", dependencyResults: Object.freeze([]),
    requestToolResults: view,
    ...(results.length || Object.keys(extras).length ? {
      requestToolResultsContextMessage: bindRequestToolResultsMessage(view, JSON.stringify({
        kind: REQUEST_TOOL_RESULTS_MESSAGE_KIND, authority: "reference_data", sourceRevision: 7,
        results: visible, ...extras,
      })),
    } : {}),
  });
}

function assessment(input: WorkerResultAuthorSource, contextMessages: readonly ChatMessage[] = []): WorkerEvidenceAssessmentReceipt {
  return Object.freeze({ binding: Object.freeze({ requestId: "report-request", callId: input.callId,
    parentCallId: input.parentCallId, invocationAttempt: input.invocationAttempt,
    objectiveFingerprint: "bound-objective", sourceRevision: input.requestToolResults.sourceRevision,
    evidenceFingerprint: "bound-evidence", evidenceRefs: Object.freeze([]) }),
    decision: Object.freeze({ requiresExecution: false, established: "The model considers the supplied evidence sufficient.",
      remaining: "", evidenceRefs: Object.freeze([]) }), contextMessages: Object.freeze([...contextMessages]) });
}

function report(input: WorkerResultAuthorSource, contexts: readonly ChatMessage[] = []) {
  return JSON.parse(buildWorkerExecutionReport(input, assessment(input, contexts)));
}

test("transfers exact visible evidence beyond 8192 characters without restoring duplicate fields", () => {
  const output = "Exact data line.\n".repeat(600);
  const canonical = result({ summary: output, referenceData: output, adapterResult: {
    kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
    result: { ok: true, tool: "example.read", output, producedNewInformation: true },
  }, references: [{ kind: "tool_target", target: "catalog.txt" }] });
  const { summary: _summary, referenceData: _referenceData, ...visible } = canonical;
  const input = source([canonical], [visible]);
  const actual = report(input);
  expect(actual.evidence.requestToolResults).toEqual(JSON.parse(input.requestToolResultsContextMessage!.content));
  expect(actual.evidence.requestToolResults.results[0]).not.toHaveProperty("summary");
  expect(actual.evidence.requestToolResults.results[0]).not.toHaveProperty("referenceData");
  expect(actual.evidence.requestToolResults.results[0].adapterResult.result.output).toBe(output);
  expect(JSON.stringify(actual).length).toBeGreaterThan(8192);
  expect(actual.assessment.authority).toBe("accepted_model_judgment");
});

test("keeps failed and superseded receipts while separating foreign evidence from own outcomes", () => {
  const failed = result({ outcome: "failed", observedEffect: "none", summary: "Permission denied." });
  const superseded = result({ executionId: "execution-2", summary: "Superseded target evidence.",
    summaryProjection: "superseded_target_evidence", supersededByExecutionIds: ["execution-3"] });
  const foreign = result({ executionId: "foreign-1", callId: "other-worker", summary: "Prior sibling observation." });
  const actual = report(source([failed, superseded, foreign]));
  expect(actual.executionOutcomes).toMatchObject([
    { executionId: failed.executionId, outcome: "failed", observedEffect: "none" },
    { executionId: superseded.executionId, summaryProjection: "superseded_target_evidence", supersededByExecutionIds: ["execution-3"] },
  ]);
  expect(actual.evidence.requestToolResults.results).toEqual([failed, superseded, foreign]);
  expect(JSON.stringify(actual).indexOf('"executionOutcomes"')).toBeLessThan(JSON.stringify(actual).indexOf('"evidence"'));
});

test("uses the current checkpoint and dependency projection without recovering hidden source bodies", () => {
  const hidden = result({ summary: "HIDDEN_ORIGINAL_BODY", referenceData: "HIDDEN_ORIGINAL_DATA" });
  const checkpoint = { kind: "runtime_semantic_compaction_checkpoint_v2", callId: "worker-1", scopeId: "worker:worker-1:request-tool-results",
    coveredSources: [{ sourceRef: hidden.executionId, sourceFingerprint: "fingerprint", digest: "Only one range was inspected." }],
    continuation: { openWork: ["Other ranges remain unknown."] },
    coveredResults: [{ executionId: hidden.executionId, callId: "worker-1", outcome: "succeeded", observedEffect: "observation" }] };
  const dependency = { resultRef: "result-1", producerCallId: "sibling-1", roleId: "worker" as const,
    outcome: "completed" as const, summary: "Prior findings.", observations: [hidden] };
  const oldAssignment = message({ kind: "runtime_worker_assignment", callId: "worker-1", invocationAttempt: 2, dependencyResults: [dependency] });
  const currentDependency = { ...dependency, observations: undefined };
  const currentAssignment = message({ kind: "runtime_worker_assignment", callId: "worker-1", invocationAttempt: 2,
    dependencyResults: [currentDependency] });
  const base = source([hidden], [], { semanticCheckpoint: checkpoint });
  const input = Object.freeze({ ...base, dependencyResults: Object.freeze([dependency]),
    handoffContextMessages: Object.freeze([currentAssignment, message(checkpoint)]) });
  const actual = report(input, [oldAssignment]);
  expect(actual.evidence.requestToolResults.semanticCheckpoint).toEqual(checkpoint);
  expect(actual.evidence.checkpoints).toEqual([checkpoint]);
  expect(actual.evidence.dependencyResults[0]).not.toHaveProperty("observations");
  expect(actual.executionOutcomes).toMatchObject([{ executionId: hidden.executionId, outcome: "succeeded" }]);
  expect(JSON.stringify(actual)).not.toContain("HIDDEN_ORIGINAL");
});

test("transfers only visible selected dependency facts, without assignment or Skill instructions", () => {
  const dependency = { resultRef: "result-1", producerCallId: "sibling-1", roleId: "worker" as const,
    outcome: "failed" as const, summary: "The assigned source was unavailable.",
    producerObjective: "DO_NOT_COPY_OBJECTIVE", observations: [result({ callId: "sibling-1" })] };
  const input = Object.freeze({ ...source(), dependencyResults: Object.freeze([dependency]) });
  const contexts = [message({ kind: "runtime_worker_assignment", callId: input.callId, invocationAttempt: input.invocationAttempt,
    objective: "DO_NOT_COPY_ASSIGNMENT", dependencyResults: [dependency, { ...dependency, resultRef: "unselected" }] }),
    message({ kind: "runtime_worker_assignment", callId: "other-worker", invocationAttempt: 2,
      dependencyResults: [{ ...dependency, summary: "WRONG_CALL" }] }),
    message({ kind: "runtime_request_source_v1", prompt: "DO_NOT_COPY_REQUEST" }),
    message({ kind: "runtime_core_skill_read", text: "DO_NOT_COPY_SKILL" })];
  const actual = report(input, contexts);
  expect(actual.evidence.dependencyResults).toHaveLength(1);
  expect(actual.evidence.dependencyResults[0]).toMatchObject({ resultRef: "result-1", outcome: "failed", observations: dependency.observations });
  expect(JSON.stringify(actual)).not.toMatch(/DO_NOT_COPY|WRONG_CALL|unselected/);
});

test("zero executions remain zero even when the accepted model judgment claims readiness", () => {
  const input = source();
  const actual = report(input);
  expect(actual).toMatchObject({ kind: "runtime_worker_execution_report_v1", authority: "reference_data",
    callId: input.callId, invocationAttempt: input.invocationAttempt, sourceRevision: 7,
    assessment: { authority: "accepted_model_judgment", requiresExecution: false }, executionOutcomes: [] });
  expect(actual.evidence).toEqual({ dependencyResults: [] });
  expect(actual).not.toHaveProperty("outcome");
  expect(actual.presenceEffect).toContain("not a new execution, verified completion");
});

test("rejects unbound or stale tool capsules instead of recovering a canonical body", () => {
  const input = source([result()]);
  for (const current of [message(JSON.parse(input.requestToolResultsContextMessage!.content)),
    bindRequestToolResultsMessage(input.requestToolResults, JSON.stringify({ kind: REQUEST_TOOL_RESULTS_MESSAGE_KIND, sourceRevision: 6, results: [] })),
    bindRequestToolResultsMessage(input.requestToolResults, "not JSON")]) {
    expect(() => report({ ...input, requestToolResultsContextMessage: current }))
      .toThrow("worker_execution_report_tool_results_binding_invalid");
  }
});

test("preserves the current bound supervision projection rather than its hidden exact source", async () => {
  const f = await createSuperCompactionSourceFixture("report-request");
  const exact = bindOperationSupervisionEvidenceMessage(f.head, f.call, JSON.stringify({
    kind: "runtime_operation_supervision_evidence_v1", entries: [{ body: "HIDDEN_SUPERVISION_BODY" }],
  }), []);
  const projected = { kind: "runtime_operation_supervision_evidence_v1", entries: [{
    originExecutionId: "capability-execution-1", evidence: { kind: "compacted_capability_result_reference", sourceRef: "capability-execution-1" },
  }] };
  const current = rebindOperationSupervisionEvidenceMessage(exact, JSON.stringify(projected));
  const input = Object.freeze({ ...source(), callId: f.call.callId, parentCallId: f.call.parentCallId!,
    invocationAttempt: f.call.activationCount, requestToolResults: f.view,
    operationSupervisionEvidenceContextMessage: exact, handoffContextMessages: Object.freeze([current]) });
  const actual = report(input, [exact]);
  expect(actual.evidence.operationSupervision).toEqual(projected);
  expect(JSON.stringify(actual)).not.toContain("HIDDEN_SUPERVISION_BODY");
  expect(() => report({ ...input, handoffContextMessages: [message(projected)] }))
    .toThrow("worker_execution_report_supervision_binding_invalid");
});

test("requires the ready assessment to match the exact call, activation and revision", () => {
  const input = source();
  const accepted = assessment(input);
  for (const binding of [{ ...accepted.binding, callId: "another-worker" },
    { ...accepted.binding, invocationAttempt: 3 }, { ...accepted.binding, sourceRevision: 8 }]) {
    expect(() => buildWorkerExecutionReport(input, { ...accepted, binding }))
      .toThrow("worker_execution_report_assessment_binding_invalid");
  }
  expect(() => buildWorkerExecutionReport(input, { ...accepted, decision: { ...accepted.decision, requiresExecution: true } }))
    .toThrow("worker_execution_report_assessment_binding_invalid");
});
