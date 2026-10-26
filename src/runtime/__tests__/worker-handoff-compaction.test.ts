import { expect, test } from "vitest";
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

test("refreshes late canonical evidence before return_result and preserves the prior digest prefix", async () => {
  const fixture = await createWorkerHandoffFixture({ lateEvidence: true });
  const result = await runWorkerDecision(
    fixture.request,
    fixture.decisionOptions,
  );
  const checkpoint = fixture.store.get(fixture.checkpoint.scopeId)!;
  const lateExecutionId = fixture.view.results.at(-1)!.executionId;

  expect(result).toEqual({
    action: "return_result",
    result: LATE_HANDOFF_MARKER,
  });
  expect(checkpoint.sourceRevision).toBe(fixture.head.revision);
  expect(JSON.stringify(checkpoint).length).toBeGreaterThan(
    JSON.stringify(fixture.checkpoint).length,
  );
  expect(fixture.request.onEvent).not.toHaveBeenCalledWith(
    "context.compaction.started",
    expect.anything(),
  );
  expect(
    checkpoint.sourceDigests.slice(0, fixture.checkpoint.sourceDigests.length),
  ).toEqual(fixture.checkpoint.sourceDigests);
  expect(checkpoint.sourceDigests.at(-1)?.sourceRef).toBe(lateExecutionId);
  expect(checkpoint.sourceDigests.at(-1)?.digest).toContain(
    LATE_HANDOFF_MARKER,
  );
  expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "worker.evidence",
    "super.compact.continuation",
    "worker.result",
  ]);
  const resultInput = fixture.invoke.mock.calls.find(
    ([input]) => input.modelStep === "worker.result",
  )![0];
  expect(JSON.stringify(resultInput.messages)).toContain(LATE_HANDOFF_MARKER);
  expect(JSON.stringify(resultInput.messages)).toContain(lateExecutionId);
});

test("does not commit the handoff candidate when request cancellation arrives during generation", async () => {
  const stopped = new Error("handoff_request_stopped");
  const fixture = await createWorkerHandoffFixture({
    lateEvidence: true,
    duringCompaction: ({ abort }) => abort.abort(stopped),
  });
  const before = JSON.stringify(fixture.store.get(fixture.checkpoint.scopeId));

  await expect(fixture.refresh()).rejects.toBe(stopped);

  expect(JSON.stringify(fixture.store.get(fixture.checkpoint.scopeId))).toBe(
    before,
  );
  expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "super.compact.continuation",
  ]);
});

test("does not commit a handoff candidate against a changed canonical Worker head", async () => {
  const fixture = await createWorkerHandoffFixture({
    lateEvidence: true,
    duringCompaction: async ({ ledger, call }) => {
      await commit(ledger, {
        authority: "active_role",
        type: "begin_capability_execution",
        callId: call.callId,
        invocationAttempt: call.activationCount,
        capabilityId: "files.read",
        declaredEffect: "observation",
        intent: "Observe a different target.",
        controlsJson: '{"path":"changed.txt"}',
        actionFingerprint: hash("changed head during handoff compaction"),
      });
    },
  });
  const before = JSON.stringify(fixture.store.get(fixture.checkpoint.scopeId));

  await expect(fixture.refresh()).rejects.toThrow(
    "request_tool_results_head_stale",
  );

  expect(JSON.stringify(fixture.store.get(fixture.checkpoint.scopeId))).toBe(
    before,
  );
  expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "super.compact.continuation",
  ]);
});
