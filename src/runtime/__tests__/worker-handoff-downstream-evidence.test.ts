import { afterEach, beforeEach, expect, test } from "vitest";
import {
  buildRequestToolResultsMessage,
  projectRequestToolResults,
} from "../context/request-tool-results.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { projectReviewerReviewSnapshot } from "../steps/reviewer-decision/projection.js";
import { buildWorkerDecisionInput } from "../steps/worker-decision/input.js";
import { completeWorkerHandoffEvidence } from "../steps/worker-decision/worker-handoff-compaction.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { commit } from "./support/super-mixed-compaction-fixture.js";
import { createWorkerHandoffFixture } from "./support/worker-handoff-compaction-fixture.js";

const TARGET = "project/final.html";
const WRITE_SUMMARY = "Created the final requested artifact.";
const WRITE_BODY = "LATE_WRITE_REFERENCE_DATA";
const ADAPTER_ONLY = "LATE_WRITE_ADAPTER_ONLY_DETAIL";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

test.each([false, true])("mixed Worker handoff preserves downstream receipt boundaries (restored checkpoint=%s)", async (restore) => {
  const f = await createWorkerHandoffFixture();
  await commit(f.ledger, {
    authority: "active_role", type: "begin_capability_execution",
    callId: f.call.callId, invocationAttempt: f.call.activationCount,
    capabilityId: "write_complete_file", declaredEffect: "mutation",
    intent: "Write the requested artifact.", controlsJson: JSON.stringify({ path: TARGET }),
  });
  const executionId = f.ledger.current().state.capabilityExecutions.at(-1)!.executionId;
  await commit(f.ledger, {
    authority: "runtime", type: "settle_capability_execution",
    callId: f.call.callId, executionId,
    outcome: "succeeded", observedEffect: "mutation", summary: WRITE_SUMMARY,
    referenceData: WRITE_BODY, references: [{ kind: "tool_target", target: TARGET }],
    exactResult: {
      kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
      result: {
        ok: true, tool: "write_complete_file", output: WRITE_SUMMARY, producedNewInformation: true,
        data: { path: TARGET, detail: ADAPTER_ONLY },
      },
    },
  });
  const head = f.ledger.current();
  const call = head.state.calls.find((item) => item.callId === f.call.callId)!;
  const view = projectRequestToolResults({ ledger: f.ledger, head, callId: call.callId, modelStep: "worker.decision" });
  const late = view.results.find((result) => result.executionId === executionId)!;
  const before = JSON.stringify(captureRequestContextCompaction(f.store));
  const store = restore ? restoreRequestContextCompaction(JSON.parse(before)) : f.store;
  const request = deriveTestRequestExecutionScope(f.request, { contextCompactionStore: store });
  const options = {
    ...f.decisionOptions, call, requestToolResults: view,
    capabilitySource: {
      ...f.decisionOptions.capabilitySource!, head,
      binding: Object.freeze({
        ...f.decisionOptions.capabilitySource!.binding,
        invocationAttempt: call.activationCount,
      }),
    },
  };
  const source = await completeWorkerHandoffEvidence(request, options, buildWorkerDecisionInput(request, options));
  const mixed = JSON.parse(source.requestToolResultsContextMessage!.content);
  expect(mixed.semanticCheckpoint.coveredSources).toEqual(f.checkpoint.sourceDigests);
  const { summary: _summary, ...visibleLate } = late;
  expect(mixed.results).toEqual([visibleLate]);
  expect(mixed.results[0]).not.toHaveProperty("summary");
  expect(mixed.results[0].adapterResult.result.output).toBe(WRITE_SUMMARY);
  expect(late.summary).toBe(WRITE_SUMMARY);
  expect([
    ...mixed.semanticCheckpoint.coveredResults.map((result: { executionId: string }) => result.executionId),
    ...mixed.results.map((result: { executionId: string }) => result.executionId),
  ].sort()).toEqual(view.results.map((result) => result.executionId).sort());
  expect(source.requestToolResultsContextMessage!.content.split(WRITE_BODY)).toHaveLength(2);
  expect(source.requestToolResultsContextMessage!.content.split(ADAPTER_ONLY)).toHaveLength(2);
  expect(JSON.stringify(captureRequestContextCompaction(store))).toBe(before);
  expect(f.invoke).not.toHaveBeenCalled();

  await commit(f.ledger, {
    authority: "runtime", type: "return_child", callerCallId: call.parentCallId!,
    childCallId: call.callId, outcome: "completed", summary: WRITE_SUMMARY,
  });
  const returned = f.ledger.current();
  const supervisorView = projectRequestToolResults({
    ledger: f.ledger, head: returned, callId: call.parentCallId!, modelStep: "supervisor.decision",
  });
  const supervisor = JSON.parse(buildRequestToolResultsMessage(supervisorView).content);
  const supervisorReceipt = supervisor.results.filter((result: { executionId: string }) => result.executionId === executionId);
  expect(supervisorReceipt).toEqual([expect.objectContaining({
    executionId, callId: call.callId, outcome: "succeeded", observedEffect: "mutation",
    summary: WRITE_SUMMARY, references: [{ kind: "tool_target", target: TARGET }],
  })]);
  expect(supervisorReceipt[0]).not.toHaveProperty("adapterResult");
  expect(supervisorReceipt[0]).not.toHaveProperty("referenceData");
  expect(JSON.stringify(supervisor)).not.toContain(ADAPTER_ONLY);
  expect(JSON.stringify(supervisor)).not.toContain(WRITE_BODY);

  await commit(f.ledger, {
    authority: "active_role", type: "open_child", callerCallId: call.parentCallId!,
    roleId: "reviewer", objective: request.prompt,
    dependencyResultRefs: [returned.state.results.at(-1)!.resultRef],
  });
  const reviewer = f.ledger.current().state.calls.at(-1)!;
  const snapshot = projectReviewerReviewSnapshot({
    requestId: request.requestId, requestObjective: request.prompt, ledger: f.ledger, call: reviewer,
    referenceDataBudget: { maxTokens: 10_000, tokenEstimation: { asciiCharactersPerToken: 4 } },
    contextCompactionStore: store, trace: false,
  });
  const lateEvidence = snapshot.evidence.filter((evidence) => evidence.evidenceRef === executionId);
  expect(lateEvidence).toEqual([expect.objectContaining({
    evidenceRef: executionId, outcome: "succeeded", effect: "mutation", summary: WRITE_SUMMARY,
    referenceData: WRITE_BODY, references: [{ kind: "tool_target", target: TARGET }],
  })]);
  for (const old of f.view.results) {
    const evidence = snapshot.evidence.filter((item) => item.evidenceRef === old.executionId);
    expect(evidence).toHaveLength(1);
    expect(JSON.parse(evidence[0]!.referenceData!)).toMatchObject({
      kind: "runtime_reviewer_compacted_evidence_v1",
      source: { sourceRef: old.executionId, digest: "Preserved exact evidence." },
    });
  }
  expect(snapshot.projectionComplete).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain(ADAPTER_ONLY);
  expect(JSON.stringify(captureRequestContextCompaction(store))).toBe(before);
  expect(f.ledger.current().state.capabilityExecutions.find((execution) => execution.executionId === executionId))
    .toMatchObject({ referenceData: WRITE_BODY, exactResult: late.adapterResult });
});
