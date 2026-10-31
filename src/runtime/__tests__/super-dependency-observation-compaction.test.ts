import { expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import {
  createRequestContextCompactionStore,
  createSemanticCompactionSha256Fingerprint as hash,
  type RequestContextCompactionStore,
} from "../context/semantic-compaction/index.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { assertSuperCompactionCheckpointIntegrity, assertSuperCompactionSourceIntegrity } from "../context/semantic-compaction/super-source-integrity.js";
import { projectSemanticCompactionDependencyResults } from "../context/semantic-compaction/dependency-results.js";
import { createCapabilityResultCompactionSource } from "../context/capability-result-compaction-source.js";
import { projectCanonicalRequestToolResult } from "../context/canonical-capability-result.js";
import { bindSuperWorkerCompactionSources, readSuperWorkerCompactionSidecar } from "../context/super-worker-compaction-sidecar.js";
import { projectSuperDependencyObservations } from "../context/super-dependency-observations.js";
import { scanDependencyObservationSources, projectDependencyObservationCheckpointMessage, resolveSuperDependencyObservationCompaction } from "../context/super-dependency-observation-compaction.js";
import { buildCheckpointMessage } from "../context/semantic-compaction/checkpoint-message.js";
import { createVerifiedCompactionProjection } from "../context/verified-compaction-projection.js";
import { dependencyObservationFixture, SELECTED_SOURCE, NESTED_SOURCE } from "./support/super-dependency-observation-fixture.js";
import { createDependencyCheckpoints } from "./support/super-dependency-compaction-fixture.js";

type Fixture = Awaited<ReturnType<typeof dependencyObservationFixture>>;

function dependencies(f: Fixture, store?: RequestContextCompactionStore) {
  return projectSemanticCompactionDependencyResults({
    requestId: f.requestId, prompt: f.prompt, head: f.head, call: f.call,
    consumer: "worker.decision", ...(store ? { store } : {}),
  });
}

function carrier(f: Fixture, kind = "runtime_worker_assignment"): ChatMessage {
  const dependencyResults = projectSuperDependencyObservations(f.head, f.call, f.dependencyResults);
  const record = { kind, callId: f.call.callId, objective: f.call.objective, dependencyResults };
  return { role: "user", content: kind === "payload"
    ? "Canonical runtime context:\n" + JSON.stringify({ worker: { callId: f.call.callId }, dependencyResults })
    : JSON.stringify(record) };
}

test("consumer sidecar admits selected observation sources with their original identities only", async () => {
  const f = await dependencyObservationFixture();
  const bound = bindSuperWorkerCompactionSources({}, f.head, f.call.callId);
  const sidecar = readSuperWorkerCompactionSidecar(bound)!;
  const expected = createDependencyCheckpoints(f).sources;
  expect(sidecar.eligibleExecutionIds).toEqual([f.firstExecutionId, f.nestedExecutionId]);
  expect(sidecar.sources).toEqual(expected);
  expect(sidecar.sources.some(source => source.sourceRef === f.unselectedExecutionId)).toBe(false);
  expect(readSuperWorkerCompactionSidecar({ ...bound })).toBeUndefined();
});

test("selected cross-Worker sources are valid in a consumer-owned checkpoint and survive restore", async () => {
  const f = await dependencyObservationFixture();
  const compacted = createDependencyCheckpoints(f, { consumerOwned: true });
  const restored = restoreRequestContextCompaction(JSON.parse(JSON.stringify(captureRequestContextCompaction(compacted.store))));
  const checkpoint = restored.get(compacted.checkpoints[0]!.scopeId)!;
  const input = { requestId: f.requestId, prompt: f.prompt, head: f.head, store: restored };
  expect(() => assertSuperCompactionSourceIntegrity(input)).not.toThrow();
  expect(() => assertSuperCompactionCheckpointIntegrity({ ...input, checkpoint })).not.toThrow();
  for (const source of compacted.sources)
    expect(restored.materializeSource(source.sourceRef, source.sourceFingerprint)).toEqual(source);
});

test("a consumer checkpoint cannot adopt an unselected sibling observation", async () => {
  const f = await dependencyObservationFixture();
  const execution = f.head.state.capabilityExecutions.find(item => item.executionId === f.unselectedExecutionId)!;
  const source = createCapabilityResultCompactionSource(projectCanonicalRequestToolResult(f.head, execution));
  const compacted = createDependencyCheckpoints(f, { sources: [source], consumerOwned: true });
  expect(() => assertSuperCompactionCheckpointIntegrity({
    requestId: f.requestId, prompt: f.prompt, head: f.head,
    store: compacted.store, checkpoint: compacted.checkpoints[0]!,
  })).toThrow();
});

test("missing checkpoints and unrelated valid checkpoints keep exact selected data", async () => {
  const f = await dependencyObservationFixture();
  const noCheckpoint = dependencies(f, createRequestContextCompactionStore());
  expect(noCheckpoint[0]!.observations).toHaveLength(2);
  const execution = f.head.state.capabilityExecutions.find(item => item.executionId === f.unselectedExecutionId)!;
  const unrelated = createDependencyCheckpoints(f, {
    sources: [createCapabilityResultCompactionSource(projectCanonicalRequestToolResult(f.head, execution))],
  });
  expect(dependencies(f, unrelated.store)).toEqual(noCheckpoint);
});

test("valid producer checkpoints replace raw dependency data after snapshot restoration", async () => {
  const f = await dependencyObservationFixture({ first: { summary: SELECTED_SOURCE } });
  const compacted = createDependencyCheckpoints(f);
  const restored = restoreRequestContextCompaction(JSON.parse(JSON.stringify(captureRequestContextCompaction(compacted.store))));
  const projected = dependencies(f, restored);
  const text = JSON.stringify(projected);
  expect(projected[0]!.observations).toBeUndefined();
  expect(text).not.toContain("SELECTED_TRANSITIVE_TOOL_ONLY");
  expect(text).not.toContain("NESTED_SELECTED_TOOL_ONLY");
  for (const checkpoint of compacted.checkpoints)
    for (const digest of checkpoint.sourceDigests)
      expect(text.split(digest.digest)).toHaveLength(2);
  expect(dependencies(f, restored)).toEqual(projected);
  for (const source of compacted.sources)
    expect(restored.materializeSource(source.sourceRef, source.sourceFingerprint)?.content).toBe(source.content);
});

test.each(["missing-source", "wrong-fingerprint", "malformed-checkpoint"] as const)(
  "%s fails integrity rather than silently removing raw observations",
  async corruption => {
    const f = await dependencyObservationFixture();
    const compacted = createDependencyCheckpoints(f);
    const badCheckpoint = JSON.parse(JSON.stringify(compacted.checkpoints[0]!));
    if (corruption === "wrong-fingerprint") badCheckpoint.sourceDigests[0].sourceFingerprint = hash("different source");
    if (corruption === "malformed-checkpoint") delete badCheckpoint.sourceDigests;
    const broken: RequestContextCompactionStore = {
      ...compacted.store,
      findByCallIds: () => [badCheckpoint],
      ...(corruption === "missing-source" ? { materializeSource: () => undefined } : {}),
    };
    expect(() => dependencies(f, broken)).toThrow();
    const raw = dependencies(f);
    expect(raw[0]!.observations).toHaveLength(2);
    expect(raw[0]!.observations![0]!.adapterResult).toMatchObject({ result: { stdout: SELECTED_SOURCE } });
  },
);

test.each(["runtime_worker_assignment", "runtime_worker_capability_execution_assignment", "runtime_worker_result_assignment", "payload"])(
  "%s compacts once, preserves assignment identity and restores without raw/summary duplication",
  async kind => {
    const f = await dependencyObservationFixture();
    const compacted = createDependencyCheckpoints(f, { consumerOwned: true });
    const checkpoint = compacted.checkpoints[0]!;
    const sourceMap = new Map(compacted.sources.map(source => [source.sourceRef, source]));
    const message = carrier(f, kind);
    const sidecar = readSuperWorkerCompactionSidecar(bindSuperWorkerCompactionSources({}, f.head, f.call.callId))!;
    expect(scanDependencyObservationSources(message, sourceMap, sidecar)).toEqual(compacted.sources);
    const projection = resolveSuperDependencyObservationCompaction(sidecar);
    expect(projection.scanCompactionSources([message], checkpoint.scopeId, sourceMap)
      .map(entry => entry.source)).toEqual(compacted.sources);
    const verified = createVerifiedCompactionProjection();
    const recorded: ChatMessage[] = [];
    const projected = projection.projectCheckpointMessages(
      [message], checkpoint.scopeId, checkpoint, sourceMap, true,
      finalMessage => { recorded.push(finalMessage); verified.record(finalMessage); },
    );
    expect(verified.contains(projected)).toBe(true);
    expect(recorded.every(finalMessage => projected.includes(finalMessage))).toBe(true);
    const text = JSON.stringify(projected);
    expect(text).not.toContain("SELECTED_TRANSITIVE_TOOL_ONLY");
    expect(text).not.toContain("NESTED_SELECTED_TOOL_ONLY");
    for (const digest of checkpoint.sourceDigests) expect(text.split(digest.digest)).toHaveLength(2);
    const projectedCarrier = projected.find(item => kind === "payload"
      ? item.content.startsWith("Canonical runtime context:") : item.content.includes('"' + kind + '"'))!;
    const record = JSON.parse(kind === "payload" ? projectedCarrier.content.split("\n").slice(1).join("\n") : projectedCarrier.content);
    expect(kind === "payload" ? record.worker.callId : record.callId).toBe(f.call.callId);
    expect(record.dependencyResults[0].observations).toBeUndefined();
    if (kind === "payload") {
      expect(projected).toHaveLength(1);
      expect(record.semanticCheckpoint.coveredSources).toEqual(checkpoint.sourceDigests);
      expect(recorded).toEqual([projectedCarrier]);
      expect(recorded[0]).toBe(projectedCarrier);
      expect(projectedCarrier).not.toBe(message);
    } else {
      expect(projected).toHaveLength(2);
      expect(JSON.parse(projected[0]!.content).kind).toBe(checkpoint.kind);
      expect(projected[1]).toBe(projectedCarrier);
    }
    expect(verified.contains(projected.map(item => ({ ...item })))).toBe(false);
    const restored = restoreRequestContextCompaction(JSON.parse(JSON.stringify(captureRequestContextCompaction(compacted.store))));
    const restoredSources = new Map(compacted.sources.map(source => [
      source.sourceRef, restored.materializeSource(source.sourceRef, source.sourceFingerprint)!,
    ]));
    expect(projection.projectCheckpointMessages([message], checkpoint.scopeId, restored.get(checkpoint.scopeId)!, restoredSources, true))
      .toEqual(projected);
  },
);

test("partial coverage keeps uncovered exact data and a mismatched digest does not drop anything", async () => {
  const f = await dependencyObservationFixture();
  const full = createDependencyCheckpoints(f, { consumerOwned: true });
  const sourceMap = new Map(full.sources.map(source => [source.sourceRef, source]));
  const message = carrier(f);
  const checkpoint = { ...full.checkpoints[0]!, sourceDigests: full.checkpoints[0]!.sourceDigests.slice(0, 1) };
  const projected = projectDependencyObservationCheckpointMessage(message, checkpoint, sourceMap)!;
  expect(projected.content).not.toContain("SELECTED_TRANSITIVE_TOOL_ONLY");
  expect(JSON.parse(projected.content).dependencyResults[0].observations[0].adapterResult.result.stdout).toBe(NESTED_SOURCE);
  const unmatched = { ...checkpoint, sourceDigests: checkpoint.sourceDigests.map(source => ({
    ...source, sourceFingerprint: hash("uncovered fingerprint"),
  })) };
  expect(projectDependencyObservationCheckpointMessage(message, unmatched, sourceMap)).toBeUndefined();
});

test("source scanning rejects missing canonical bytes, forged visible bytes and unselected eligibility", async () => {
  const f = await dependencyObservationFixture();
  const compacted = createDependencyCheckpoints(f, { consumerOwned: true });
  const sourceMap = new Map(compacted.sources.map(source => [source.sourceRef, source]));
  const message = carrier(f);
  expect(() => scanDependencyObservationSources(message, new Map())).toThrow();
  const forged: ChatMessage = { role: "user", content: message.content.replace("SELECTED_TRANSITIVE_TOOL_ONLY", "FORGED_TOOL_ONLY") };
  expect(() => scanDependencyObservationSources(forged, sourceMap)).toThrow();
  const sidecar = readSuperWorkerCompactionSidecar(bindSuperWorkerCompactionSources({}, f.head, f.call.callId))!;
  expect(() => scanDependencyObservationSources(message, sourceMap, { ...sidecar, eligibleExecutionIds: [] })).toThrow();
});

test("ordinary assignments with no observations retain exact identity and contribute no sources", async () => {
  const message: ChatMessage = { role: "user", content: '{"kind":"runtime_worker_assignment","dependencyResults":[{"summary":"ordinary context"}]}' };
  const f = await dependencyObservationFixture();
  const compacted = createDependencyCheckpoints(f, { consumerOwned: true });
  expect(scanDependencyObservationSources(message, new Map())).toEqual([]);
  expect(projectDependencyObservationCheckpointMessage(message, compacted.checkpoints[0]!, new Map())).toBeUndefined();
  expect(message.content).toBe('{"kind":"runtime_worker_assignment","dependencyResults":[{"summary":"ordinary context"}]}');
});


test.each([true, false])("mixed ordinary/dependency sources keep source order and one summary (dependency first: %s)", async dependencyFirst => {
  const f = await dependencyObservationFixture();
  const compacted = createDependencyCheckpoints(f, { consumerOwned: true });
  const sidecar = readSuperWorkerCompactionSidecar(bindSuperWorkerCompactionSources({}, f.head, f.call.callId))!;
  const projection = resolveSuperDependencyObservationCompaction(sidecar);
  const sourceMap = new Map(compacted.sources.map(source => [source.sourceRef, source]));
  const assignment = carrier(f);
  const ordinary: ChatMessage = { role: "tool", toolCallId: "ordinary-tool", toolName: "fixture_read", content: "ORDINARY_SOURCE_BYTES" };
  const prefix: ChatMessage = { role: "system", content: "stable policy" };
  const intent: ChatMessage = { role: "user", content: f.prompt };
  const tail: ChatMessage = { role: "user", content: "stable continuation" };
  const messages = [prefix, intent, ...(dependencyFirst ? [assignment, ordinary] : [ordinary, assignment]), tail];
  const scanned = projection.scanCompactionSources(messages, compacted.checkpoints[0]!.scopeId, sourceMap);
  const dependencyIds = compacted.sources.map(source => source.sourceRef);
  expect(scanned.map(entry => entry.source.sourceRef)).toEqual(dependencyFirst
    ? [...dependencyIds, "tool-result:ordinary-tool"] : ["tool-result:ordinary-tool", ...dependencyIds]);
  expect(scanned.map(entry => entry.index)).toEqual(dependencyFirst ? [2, 2, 3] : [2, 3, 3]);
  for (const { source } of scanned) sourceMap.set(source.sourceRef, source);
  const checkpoint = { ...compacted.checkpoints[0]!, sourceDigests: scanned.map(({ source }) => ({
    sourceRef: source.sourceRef, sourceFingerprint: source.sourceFingerprint, digest: "MIXED_DIGEST_" + source.sourceRef,
  })) };
  const verified = createVerifiedCompactionProjection();
  const projected = projection.projectCheckpointMessages(messages, checkpoint.scopeId, checkpoint, sourceMap, true, verified.record);
  expect(projected).toHaveLength(5);
  expect(projected[0]).toBe(prefix);
  expect(projected[1]).toBe(intent);
  expect(JSON.parse(projected[2]!.content).coveredSources).toEqual(checkpoint.sourceDigests);
  expect(JSON.parse(projected[3]!.content).dependencyResults[0].observations).toBeUndefined();
  expect(projected[4]).toBe(tail);
  expect(projected).not.toContain(ordinary);
  expect(verified.contains(projected)).toBe(true);
  const text = JSON.stringify(projected);
  for (const digest of checkpoint.sourceDigests) expect(text.split(digest.digest)).toHaveLength(2);
  expect(text).not.toContain("ORDINARY_SOURCE_BYTES");
  expect(text).not.toContain("SELECTED_TRANSITIVE_TOOL_ONLY");
  expect(projection.scanCompactionSources(projected, checkpoint.scopeId, sourceMap)).toEqual([]);
});

test.each([true, false])("an existing standalone checkpoint stays before covered dependencies (prior first: %s)", async priorFirst => {
  const f = await dependencyObservationFixture();
  const compacted = createDependencyCheckpoints(f, { consumerOwned: true });
  const checkpoint = compacted.checkpoints[0]!;
  const sourceMap = new Map(compacted.sources.map(source => [source.sourceRef, source]));
  const projection = resolveSuperDependencyObservationCompaction(
    readSuperWorkerCompactionSidecar(bindSuperWorkerCompactionSources({}, f.head, f.call.callId))!,
  );
  const assignment = carrier(f);
  const previous = buildCheckpointMessage({ ...checkpoint, sourceRevision: checkpoint.sourceRevision - 1 });
  const prefix: ChatMessage = { role: "system", content: "stable policy" };
  const intent: ChatMessage = { role: "user", content: f.prompt };
  const tail: ChatMessage = { role: "user", content: "stable continuation" };
  const messages = priorFirst ? [prefix, previous, intent, assignment, tail] : [prefix, intent, assignment, previous, tail];
  const verified = createVerifiedCompactionProjection();
  const projected = projection.projectCheckpointMessages(messages, checkpoint.scopeId, checkpoint, sourceMap, true, verified.record);
  expect(projected).toHaveLength(5);
  expect(projected[0]).toBe(prefix);
  expect(projected[priorFirst ? 2 : 1]).toBe(intent);
  expect(JSON.parse(projected[priorFirst ? 1 : 2]!.content).sourceRevision).toBe(checkpoint.sourceRevision);
  expect(JSON.parse(projected[3]!.content).dependencyResults[0].observations).toBeUndefined();
  expect(projected[4]).toBe(tail);
  expect(projected).not.toContain(previous);
  expect(verified.contains(projected)).toBe(true);
  expect(projected.filter(message => message.content.includes('"kind":"runtime_semantic_compaction_checkpoint_v2"'))).toHaveLength(1);
});
