import { expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { runWorkerDecision } from "../steps/worker-decision/run.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/index.js";
import { commit } from "./support/super-mixed-compaction-fixture.js";
import {
  createWorkerHandoffFixture,
  LATE_HANDOFF_MARKER,
} from "./support/worker-handoff-compaction-fixture.js";

test("retains an existing handoff checkpoint byte-for-byte without new sources or a compactor call", async () => {
  const fixture = await createWorkerHandoffFixture();
  const before = JSON.stringify(fixture.store.get(fixture.checkpoint.scopeId));
  const source = await fixture.refresh();

  expect(JSON.stringify(fixture.store.get(fixture.checkpoint.scopeId))).toBe(
    before,
  );
  expect(fixture.invoke).not.toHaveBeenCalled();
  expect(source.requestToolResultsContextMessage?.content).toContain(
    "Preserved exact evidence.",
  );
  expect(source.requestToolResults.results).toHaveLength(
    fixture.view.results.length,
  );
});

test("hands off late canonical evidence below the model threshold without forcing compaction", async () => {
  const fixture = await createWorkerHandoffFixture({ lateEvidence: true });
  const before = JSON.stringify(fixture.store.get(fixture.checkpoint.scopeId));
  const result = await runWorkerDecision(
    fixture.request,
    fixture.decisionOptions,
  );
  const checkpoint = fixture.store.get(fixture.checkpoint.scopeId)!;
  const lateExecutionId = fixture.view.results.at(-1)!.executionId;

  expect(result.action).toBe("return_result");
  if (result.action !== "return_result") throw new Error("expected Worker report");
  const report = JSON.parse(result.result);
  expect(report.assessment.requiresExecution).toBe(false);
  expect(JSON.stringify(checkpoint)).toBe(before);
  expect(fixture.request.onEvent).not.toHaveBeenCalledWith(
    "context.compaction.started",
    expect.anything(),
  );
  expect(
    checkpoint.sourceDigests.slice(0, fixture.checkpoint.sourceDigests.length),
  ).toEqual(fixture.checkpoint.sourceDigests);
  expect(checkpoint.sourceDigests.some(({ sourceRef }) => sourceRef === lateExecutionId)).toBe(false);
  expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "worker.decision",
  ]);
  const decisionInput = fixture.invoke.mock.calls.find(
    ([input]) => input.modelStep === "worker.decision",
  )![0];
  const decisionEvidence = (decisionInput.messages as readonly ChatMessage[]).map(({ content }) => {
    if (!content.startsWith("{")) return undefined;
    return JSON.parse(content);
  }).find((message) => message?.kind === "runtime_request_tool_results_v1");
  const resultEvidence = report.evidence.requestToolResults;
  expect(resultEvidence).toEqual(decisionEvidence);
  expect(resultEvidence.semanticCheckpoint.coveredSources).toEqual(fixture.checkpoint.sourceDigests);
  expect(resultEvidence.results.find((result: { executionId: string }) => result.executionId === lateExecutionId))
    .toMatchObject({ referenceData: LATE_HANDOFF_MARKER });
  expectFinalMeasuredEnvelope(fixture);
});

test("decision admission compacts late evidence once and the report preserves that checkpoint", async () => {
  const fixture = await createWorkerHandoffFixture({ lateEvidence: true, pressureStep: "worker.decision" });
  const result = await runWorkerDecision(fixture.request, fixture.decisionOptions);
  expect(result.action).toBe("return_result");
  if (result.action !== "return_result") throw new Error("expected Worker report");
  expect(result.result).toContain(LATE_HANDOFF_MARKER);

  expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "super.compact.continuation", "worker.decision",
  ]);
  const checkpoint = fixture.store.get(fixture.checkpoint.scopeId)!;
  expect(checkpoint.sourceRevision).toBe(fixture.head.revision);
  expect(checkpoint.sourceDigests.slice(0, fixture.checkpoint.sourceDigests.length))
    .toEqual(fixture.checkpoint.sourceDigests);
  expect(checkpoint.sourceDigests.at(-1)).toMatchObject({
    sourceRef: fixture.view.results.at(-1)!.executionId,
  });
  expect(checkpoint.sourceDigests.at(-1)!.digest).toContain(LATE_HANDOFF_MARKER);
  const lifecycle = compactionLifecycle(fixture);
  expect(lifecycle.map(([name]) => name)).toEqual([
    "context.compaction.started", "context.compaction.completed",
  ]);
  expect(lifecycle[0]![1]).toMatchObject({ modelStep: "worker.decision", beforeInputTokens: 95000 });
  expect(lifecycle[1]![1]).toMatchObject({
    modelStep: "worker.decision", invocationId: lifecycle[0]![1]!.invocationId,
  });
  expect(fixture.request.onEvent).toHaveBeenCalledWith("context.compaction.progress", expect.objectContaining({
    modelStep: "worker.decision", invocationId: lifecycle[0]![1]!.invocationId,
  }));
  expect(JSON.parse(result.result).evidence.requestToolResults.semanticCheckpoint.coveredSources)
    .toEqual(checkpoint.sourceDigests);
  expectFinalMeasuredEnvelope(fixture);
});

test("refreshes stale pre-evidence input from the checkpoint committed by evidence admission without another cycle", async () => {
  const fixture = await createWorkerHandoffFixture({ lateEvidence: true, pressureStep: "worker.decision" });
  const staleInput = fixture.buildInput();
  const result = await runWorkerDecision(fixture.request, fixture.decisionOptions);
  const latest = fixture.store.get(fixture.checkpoint.scopeId)!;
  const callsBeforeRefresh = fixture.invoke.mock.calls.length;
  const source = await fixture.refresh(staleInput);

  expect(latest.sourceRevision).toBe(fixture.head.revision);
  expect(fixture.store.get(fixture.checkpoint.scopeId)).toBe(latest);
  expect(fixture.invoke).toHaveBeenCalledTimes(callsBeforeRefresh);
  expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "super.compact.continuation", "worker.decision",
  ]);
  const projected = JSON.parse(source.requestToolResultsContextMessage!.content);
  expect(projected.semanticCheckpoint.checkpointSourceRevision).toBe(latest.sourceRevision);
  expect(projected.semanticCheckpoint.coveredSources).toEqual(latest.sourceDigests);
  expect(projected.results).toEqual([]);
  expect(result.action).toBe("return_result");
  if (result.action !== "return_result") throw new Error("expected Worker report");
  expect(JSON.parse(result.result).evidence.requestToolResults).toEqual(projected);
  expect(result.result).toContain(LATE_HANDOFF_MARKER);
  expect(compactionLifecycle(fixture).map(([name, data]) => [name, data!.modelStep])).toEqual([
    ["context.compaction.started", "worker.decision"],
    ["context.compaction.completed", "worker.decision"],
  ]);
  expectFinalMeasuredEnvelope(fixture);
});

test("does not change a checkpoint when the handoff is already cancelled", async () => {
  const stopped = new Error("handoff_request_stopped");
  const fixture = await createWorkerHandoffFixture({ lateEvidence: true });
  const before = JSON.stringify(fixture.store.get(fixture.checkpoint.scopeId));
  fixture.abort.abort(stopped);

  await expect(fixture.refresh()).rejects.toBe(stopped);

  expect(JSON.stringify(fixture.store.get(fixture.checkpoint.scopeId))).toBe(
    before,
  );
  expect(fixture.invoke).not.toHaveBeenCalled();
});

test("does not project a handoff against a changed canonical Worker head", async () => {
  const fixture = await createWorkerHandoffFixture({ lateEvidence: true });
  const input = fixture.buildInput();
  const before = JSON.stringify(fixture.store.get(fixture.checkpoint.scopeId));
  await commit(fixture.ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: fixture.call.callId,
    invocationAttempt: fixture.call.activationCount,
    capabilityId: "files.read",
    declaredEffect: "observation",
    intent: "Observe a different target.",
    controlsJson: '{"path":"changed.txt"}',
    actionFingerprint: hash("changed head during handoff compaction"),
  });

  await expect(fixture.refresh(input)).rejects.toThrow(
    "request_tool_results_head_stale",
  );

  expect(JSON.stringify(fixture.store.get(fixture.checkpoint.scopeId))).toBe(
    before,
  );
  expect(fixture.invoke).not.toHaveBeenCalled();
});

test("normal admission cancellation preserves the checkpoint and does not send a result", async () => {
  const stopped = new Error("handoff_request_stopped");
  const fixture = await createWorkerHandoffFixture({
    lateEvidence: true,
    pressureStep: "worker.decision",
    duringCompaction: ({ abort }) => abort.abort(stopped),
  });
  const before = JSON.stringify(fixture.store.get(fixture.checkpoint.scopeId));
  await expect(runWorkerDecision(fixture.request, fixture.decisionOptions)).rejects.toBe(stopped);
  expect(JSON.stringify(fixture.store.get(fixture.checkpoint.scopeId))).toBe(before);
  expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "super.compact.continuation",
  ]);
  expect(compactionLifecycle(fixture).map(([name]) => name)).toEqual([
    "context.compaction.started", "context.compaction.failed",
  ]);
});

function compactionLifecycle(fixture: Awaited<ReturnType<typeof createWorkerHandoffFixture>>) {
  return vi.mocked(fixture.request.onEvent!).mock.calls.filter(([name]) =>
    /^context\.compaction\.(started|completed|failed)$/u.test(name));
}

function expectFinalMeasuredEnvelope(
  fixture: Awaited<ReturnType<typeof createWorkerHandoffFixture>>,
) {
  const modelStep = "worker.decision";
  const sent = fixture.invoke.mock.calls.find(([input]) => input.modelStep === modelStep)![0];
  const measured = fixture.measurements.filter((input) => input.modelStep === modelStep).at(-1)!;
  expect(measured.messages).toEqual(sent.messages);
  expect(measured.inputTokens).toBeLessThan(128000 * 0.7);
}
