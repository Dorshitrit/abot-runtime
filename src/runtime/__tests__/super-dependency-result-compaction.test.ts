import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/index.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { resolveSuperDependencyObservationCompaction } from "../context/super-dependency-observation-compaction.js";
import { bindSuperWorkerCompactionSources, readSuperWorkerCompactionSidecar } from "../context/super-worker-compaction-sidecar.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { captureRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { restoreApprovalCompaction } from "../request/approval-wait/super-compaction-restore.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { projectWorkerPayloadDependencyResults } from "../steps/worker-decision/payload-dependency-results.js";
import {
  dependencyResultCompactionFixture, DEPENDENCY_BODY_MARKER, UNSELECTED_RESULT_MARKER,
} from "./support/dependency-result-compaction-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

function assignment(messages: readonly ChatMessage[]) {
  for (const message of messages) {
    let value;
    try { value = JSON.parse(message.content); } catch { continue; }
    if (value.kind === "runtime_worker_assignment") return value;
  }
  throw new Error("test_worker_assignment_missing");
}

function assertCompactedReport(
  f: Awaited<ReturnType<typeof dependencyResultCompactionFixture>>,
  messages: readonly ChatMessage[],
) {
  const text = JSON.stringify(messages);
  expect(text).not.toContain(DEPENDENCY_BODY_MARKER);
  expect(text).not.toContain("SOURCE_END");
  expect(text).not.toContain(UNSELECTED_RESULT_MARKER);
  const original = assignment(f.messages).dependencyResults[0];
  const projected = assignment(messages).dependencyResults[0];
  expect(projected).toMatchObject({ resultRef: f.selected.resultRef,
    producerCallId: f.selected.producerCallId, roleId: "worker", outcome: "completed",
    receipt: original.receipt,
    summaryProjection: { kind: "semantic_checkpoint", scopeId: f.scopeId,
      sourceRef: `dependency-result:${f.selected.resultRef}` },
  });
  expect(projected.summary).not.toBe(f.selected.summary);
  const checkpoint = f.store.get(f.scopeId)!;
  for (const { digest } of checkpoint.sourceDigests)
    expect(text.split(digest)).toHaveLength(2);
  expect(f.ledger.current().state.results.find(result => result.resultRef === f.selected.resultRef))
    .toEqual(f.selected);
}

async function parkForApproval(f: Awaited<ReturnType<typeof dependencyResultCompactionFixture>>) {
  await f.commit({ authority: "active_role", type: "begin_capability_execution",
    callId: f.call.callId, invocationAttempt: f.call.activationCount, capabilityId: "source.write",
    declaredEffect: "mutation", intent: "Write only after approval.", controlsJson: "{}",
    actionFingerprint: hash("pending approved mutation") });
  return f.ledger.current().state.capabilityExecutions.at(-1)!.executionId;
}

test("a canonical report over 100KB compacts once as a selected dependency without losing its receipt", async () => {
  const f = await dependencyResultCompactionFixture();
  expect(Buffer.byteLength(f.selected.summary, "utf8")).toBeGreaterThan(100_000);
  expect(JSON.parse(f.selected.summary).kind).toBe("runtime_worker_execution_report_v1");
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual(["worker.decision"]);
  const before = JSON.stringify(f.head);
  expect(JSON.stringify(f.messages)).toContain(DEPENDENCY_BODY_MARKER);
  const projected = await f.compact();
  expect(f.generated).toHaveLength(1);
  const summaries = f.generated[0]!.sources.filter(source => source.sourceRef.startsWith("dependency-result:"));
  expect(summaries).toHaveLength(1);
  expect(summaries[0]!.sourceRef).toBe(`dependency-result:${f.selected.resultRef}`);
  expect(summaries[0]!.sourceFingerprint).toBe(hash(summaries[0]!.content));
  expect(summaries[0]!.content).toContain(DEPENDENCY_BODY_MARKER);
  expect(f.generated[0]!.sources.some(source => source.content.includes(UNSELECTED_RESULT_MARKER))).toBe(false);
  assertCompactedReport(f, projected);
  expect(f.controller().project(projected)).toEqual(projected);
  expect(JSON.stringify(f.head)).toBe(before);
});

test.each([false, true])("checkpoint roundtrip preserves report projection through approval restore=%s", async approval => {
  const f = await dependencyResultCompactionFixture();
  const projected = await f.compact();
  const snapshot = JSON.parse(JSON.stringify(captureRequestContextCompaction(f.store)));
  const pendingExecutionId = approval ? await parkForApproval(f) : undefined;
  const restored = approval ? restoreApprovalCompaction({ snapshot,
    ledgerCheckpoint: captureRoleCallLedgerCheckpoint(f.ledger), requestId: f.requestId,
    prompt: f.prompt, executionPolicy: f.policy }) : restoreRequestContextCompaction(snapshot);
  expect(captureRequestContextCompaction(restored)).toEqual(snapshot);
  if (pendingExecutionId) await f.commit({ authority: "runtime", type: "settle_capability_execution",
    callId: f.call.callId, executionId: pendingExecutionId, outcome: "succeeded",
    observedEffect: "mutation", summary: "Approved operation settled before Worker continuation.",
    exactResult: Object.freeze({ kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
      result: Object.freeze({ ok: true, tool: "source.write", output: "Approved operation settled before Worker continuation.",
        progress: true, producedNewInformation: true }) }) });
  const resumed = f.controller(restored, f.ledger.current()).project(f.messagesFor(restored, f.ledger.current()));
  expect(assignment(resumed).dependencyResults).toEqual(assignment(projected).dependencyResults);
  if (!approval) expect(resumed).toEqual(projected);
  assertCompactedReport(f, resumed);
  expect(f.generated).toHaveLength(1);
  if (approval) expect(f.ledger.current().state.capabilityExecutions.at(-1)!.status).toBe("settled");
});

test.each(["unselected", "forged-summary"] as const)("rejects %s dependency before source registration", async mode => {
  const f = await dependencyResultCompactionFixture();
  const source = assignment(f.messages);
  const dependency = source.dependencyResults[0];
  const changed = mode === "unselected" ? {
    ...dependency, resultRef: f.unselected.resultRef, producerCallId: f.unselected.producerCallId,
    summary: f.unselected.summary, receipt: f.unselected.receipt,
  } : { ...dependency, summary: dependency.summary.replace(DEPENDENCY_BODY_MARKER, "FORGED_DEPENDENCY_BODY") };
  const messages = f.messages.map(message => message.role === "user" && message.content === JSON.stringify(source)
    ? { ...message, content: JSON.stringify({ ...source, dependencyResults: [changed] }) } : message);
  await expect(f.compact(messages)).rejects.toThrow();
  expect(f.generated).toEqual([]);
  expect(captureRequestContextCompaction(f.store).sources).toEqual([]);
  expect(f.ledger.current().state.results.find(result => result.resultRef === f.selected.resultRef)).toEqual(f.selected);
});

test.each(["stale-fingerprint", "forged-source"] as const)("approval restore rejects %s before continuation", async mode => {
  const f = await dependencyResultCompactionFixture();
  await f.compact();
  await parkForApproval(f);
  const snapshot = JSON.parse(JSON.stringify(captureRequestContextCompaction(f.store)));
  const ref = `dependency-result:${f.selected.resultRef}`;
  const source = snapshot.sources.find((candidate: { sourceRef: string }) => candidate.sourceRef === ref)!;
  const digest = snapshot.checkpoints[0].sourceDigests.find((candidate: { sourceRef: string }) => candidate.sourceRef === ref)!;
  if (mode === "forged-source") {
    source.content = source.content.replace(DEPENDENCY_BODY_MARKER, "FORGED_DEPENDENCY_BODY");
    source.sourceFingerprint = hash(source.content);
    digest.sourceFingerprint = source.sourceFingerprint;
  } else digest.sourceFingerprint = hash("stale canonical source");
  const before = JSON.stringify(snapshot);
  expect(() => restoreApprovalCompaction({ snapshot,
    ledgerCheckpoint: captureRoleCallLedgerCheckpoint(f.ledger), requestId: f.requestId,
    prompt: f.prompt, executionPolicy: f.policy })).toThrow("context_compaction_snapshot_source_incompatible");
  expect(JSON.stringify(snapshot)).toBe(before);
  expect(f.invoke).toHaveBeenCalledOnce();
});

test("a payload carrier retains its permitted dependency fields and one verified digest", async () => {
  const f = await dependencyResultCompactionFixture();
  await f.compact();
  const checkpoint = f.store.get(f.scopeId)!;
  const dependencyResults = projectWorkerPayloadDependencyResults(assignment(f.messages).dependencyResults);
  const payload: ChatMessage = { role: "user", content: "Canonical runtime context:\n" + JSON.stringify({
    worker: { callId: f.call.callId }, dependencyResults,
  }) };
  const sourceMap = new Map(f.sidecar.sources.map(source => [source.sourceRef, source]));
  const projected = resolveSuperDependencyObservationCompaction(f.sidecar)
    .projectCheckpointMessages([payload], f.scopeId, checkpoint, sourceMap, true);
  expect(projected).toHaveLength(1);
  const record = JSON.parse(projected[0]!.content.slice("Canonical runtime context:\n".length));
  expect(record.dependencyResults[0]).toMatchObject({
    resultRef: f.selected.resultRef, producerCallId: f.selected.producerCallId,
    summaryProjection: { sourceRef: `dependency-result:${f.selected.resultRef}` },
  });
  expect(record.dependencyResults[0]).not.toHaveProperty("receipt");
  const text = JSON.stringify(projected);
  expect(text).not.toContain(DEPENDENCY_BODY_MARKER);
  for (const { digest } of checkpoint.sourceDigests) expect(text.split(digest)).toHaveLength(2);
});

test("a forged compacted-summary annotation is rejected without reviving the original report", async () => {
  const f = await dependencyResultCompactionFixture();
  const projected = await f.compact();
  const record = assignment(projected);
  record.dependencyResults[0].summaryProjection.sourceFingerprint = hash("forged checkpoint pointer");
  const changed = projected.map(message => message.role === "user" && message.content.includes('"kind":"runtime_worker_assignment"')
    ? { ...message, content: JSON.stringify(record) } : message);
  expect(() => f.controller().project(changed)).toThrow();
  expect(JSON.stringify(changed)).not.toContain(DEPENDENCY_BODY_MARKER);
  expect(f.invoke).toHaveBeenCalledOnce();
});

test("unbound and EA user JSON do not acquire canonical dependency source authority", async () => {
  const f = await dependencyResultCompactionFixture();
  const head = { ...f.head, policy: { ...f.head.policy,
    authority: resolveRequestExecutionPolicy("execution-agent-v1").authority } };
  const eaSidecar = readSuperWorkerCompactionSidecar(bindSuperWorkerCompactionSources({}, head, f.call.callId));
  expect(eaSidecar).toBeUndefined();
  const userJson: ChatMessage = { role: "user", content: JSON.stringify(assignment(f.messages)) };
  for (const sidecar of [undefined, eaSidecar]) {
    const projection = resolveSuperDependencyObservationCompaction(sidecar);
    expect(projection.scanCompactionSources([userJson], f.scopeId, new Map())).toEqual([]);
  }
  expect(JSON.parse(userJson.content).dependencyResults[0].summary).toBe(f.selected.summary);
});
