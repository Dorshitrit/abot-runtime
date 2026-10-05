import { expect, test, vi } from "vitest";
import {
  mixedWorkerFixture,
  commit,
} from "./support/super-mixed-compaction-fixture.js";
import { createRootInvalidOutputRequest } from "./support/root-invalid-output-fixture.js";
import { SuperContextFailure } from "../context/super-context-failure.js";
import { quarantineProvenUnusableSuperCheckpoint } from "../request/super-checkpoint-quarantine.js";
import { hasSafeSuperContextFailureReturn } from "../request/super-context-failure-integrity.js";
import { restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { createRequestContextCompactionStore } from "../context/semantic-compaction/store.js";
import { containSuperContextFailures } from "../request/super-context-failure-executor.js";
import { createRoleExecutorRegistry } from "../orchestration/role-executors/index.js";
import { projectCanonicalCapabilityResultCompactionSources } from "../context/capability-result-compaction-source.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";

async function fixture(futureCheckpoint = false) {
  const data = await mixedWorkerFixture();
  if (futureCheckpoint)
    data.store.commit({
      ...data.checkpoint,
      sourceRevision: data.head.revision + 1,
    });
  const request = createRootInvalidOutputRequest(
    vi.fn(),
    "supervisor-worker-v1",
    {
      requestId: data.head.state.requestId,
      prompt: "Inspect the target.",
      contextCompactionStore: data.store,
    },
  );
  const error = new SuperContextFailure(
    "request_tool_results_compaction_source_missing",
    {
      requestId: request.requestId,
      callId: data.call.callId,
      parentCallId: data.call.parentCallId,
      invocationAttempt: data.call.activationCount,
      sourceRevision: data.head.revision,
      contractId: "delegated.worker",
      modelStep: "worker.decision",
      phase: "projection",
      scopeId: data.checkpoint.scopeId,
    },
    new Error("projection_rejected"),
  );
  return {
    ...data,
    params: {
      error,
      request,
      ledger: data.ledger,
      expectedHead: data.head,
      call: data.call,
      contractId: "delegated.worker",
    },
  };
}

test("F3: a presentation failure preserves a valid committed checkpoint and sources", async () => {
  const { store, checkpoint, sources, params } = await fixture();
  quarantineProvenUnusableSuperCheckpoint(params);
  expect(hasSafeSuperContextFailureReturn(params)).toBe(true);
  expect(store.get(checkpoint.scopeId)).toEqual(checkpoint);
  expect(store.snapshot!()).toEqual({
    kind: "request_context_compaction_v1",
    checkpoints: [checkpoint],
    sources,
  });
  const restored = restoreRequestContextCompaction(
    JSON.parse(JSON.stringify(store.snapshot!())),
    { restoreSuperQuarantine: true },
  );
  expect(restored.get(checkpoint.scopeId)).toEqual(checkpoint);
});

test("F3: independent proof quarantines only the bad derivative; sources survive", async () => {
  const { store, checkpoint, sources, params } = await fixture(true);
  expect(hasSafeSuperContextFailureReturn(params)).toBe(false);
  quarantineProvenUnusableSuperCheckpoint(params);
  expect(hasSafeSuperContextFailureReturn(params)).toBe(true);
  expect(() => store.get(checkpoint.scopeId)).toThrow(
    "context_compaction_scope_invalidated",
  );
  expect(() => store.commit(checkpoint)).toThrow(
    "context_compaction_scope_invalidated",
  );
  expect(store.findByCallIds([checkpoint.callId])).toEqual([]);
  const snapshot = store.snapshot!();
  expect(snapshot.checkpoints).toEqual([]);
  expect(snapshot.sources).toEqual(sources);
  expect(snapshot.invalidatedScopes).toMatchObject([
    {
      scopeId: checkpoint.scopeId,
      failureCode: "context_compaction_checkpoint_revision_invalid",
    },
  ]);
  const restored = restoreRequestContextCompaction(
    JSON.parse(JSON.stringify(snapshot)),
    { restoreSuperQuarantine: true },
  );
  expect(() => restored.get(checkpoint.scopeId)).toThrow(
    "context_compaction_scope_invalidated",
  );
  expect(restored.snapshot!().sources).toEqual(sources);
});

test("quarantining one owned checkpoint preserves a healthy sibling across snapshot restore", async () => {
  const { ledger, store, checkpoint: sibling, params } = await fixture();
  await commit(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-1",
    childCallId: sibling.callId,
    outcome: "completed",
    summary: "Read the first target.",
  });
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "worker",
    objective: "Read the second target.",
  });
  const opened = ledger.current().state.calls.at(-1)!;
  await commit(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: opened.callId,
    invocationAttempt: opened.activationCount,
    capabilityId: "files.read",
    declaredEffect: "observation",
    intent: "Read second target.",
    controlsJson: '{"path":"second.txt"}',
  });
  await commit(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: opened.callId,
    executionId: ledger.current().state.capabilityExecutions.at(-1)!
      .executionId,
    outcome: "succeeded",
    observedEffect: "observation",
    summary: "Read second target.",
    exactResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: { content: "Second evidence." },
    },
  });
  const head = ledger.current();
  const call = head.state.calls.at(-1)!;
  const sources = projectCanonicalCapabilityResultCompactionSources({
    head,
    callId: call.callId,
  });
  store.registerSources(sources);
  const checkpoint = {
    ...sibling,
    callId: call.callId,
    objectiveFingerprint: hash(call.objective!),
    scopeId: `worker:${call.callId}:request-tool-results`,
    sourceRevision: head.revision + 1,
    sourceDigests: sources.map((source) => ({
      sourceRef: source.sourceRef,
      sourceFingerprint: source.sourceFingerprint,
      digest: "Second evidence.",
    })),
    continuation: {
      ...sibling.continuation,
      evidenceRefs: sources.map((source) => source.sourceRef),
    },
  };
  store.commit(checkpoint);
  const inventory = store.snapshot!().sources;
  const error = new SuperContextFailure(
    "context_compaction_checkpoint_revision_invalid",
    {
      ...params.error.binding,
      callId: call.callId,
      parentCallId: call.parentCallId,
      invocationAttempt: call.activationCount,
      sourceRevision: head.revision,
      scopeId: checkpoint.scopeId,
    },
    new Error("bad_derived_revision"),
  );
  const current = { ...params, expectedHead: head, call, error };
  quarantineProvenUnusableSuperCheckpoint(current);
  expect(hasSafeSuperContextFailureReturn(current)).toBe(true);
  expect(store.findByCallIds([sibling.callId, call.callId])).toEqual([sibling]);
  expect(store.snapshot!().sources).toEqual(inventory);
  const restored = restoreRequestContextCompaction(
    JSON.parse(JSON.stringify(store.snapshot!())),
    { restoreSuperQuarantine: true },
  );
  expect(restored.get(sibling.scopeId)).toEqual(sibling);
  expect(() => restored.get(checkpoint.scopeId)).toThrow(
    "context_compaction_scope_invalidated",
  );
});

test("a source-integrity defect cannot be disguised as a quarantined checkpoint", async () => {
  const { store, checkpoint, params, sources } = await fixture(true);
  const missing = createRequestContextCompactionStore();
  missing.registerSources(sources.slice(1));
  missing.commit({
    ...checkpoint,
    sourceRevision: params.expectedHead.revision + 1,
  });
  const changed = {
    ...params,
    request: { ...params.request, contextCompactionStore: missing },
  };
  quarantineProvenUnusableSuperCheckpoint(changed);
  expect(hasSafeSuperContextFailureReturn(changed)).toBe(false);
  expect(missing.snapshot!()).not.toHaveProperty("invalidatedScopes");
  expect(store.snapshot!()).not.toHaveProperty("invalidatedScopes");
});

test("a rejected candidate without a committed checkpoint does not create quarantine", async () => {
  const { params, sources } = await fixture();
  const store = createRequestContextCompactionStore();
  store.registerSources(sources);
  const changed = {
    ...params,
    request: { ...params.request, contextCompactionStore: store },
  };
  quarantineProvenUnusableSuperCheckpoint(changed);
  expect(hasSafeSuperContextFailureReturn(changed)).toBe(true);
  expect(store.snapshot!()).not.toHaveProperty("invalidatedScopes");
});

test("EA restore does not start interpreting new SUPER quarantine metadata", async () => {
  const { store, params, checkpoint } = await fixture(true);
  quarantineProvenUnusableSuperCheckpoint(params);
  const snapshot = store.snapshot!();
  const ea = restoreRequestContextCompaction({
    ...snapshot,
    invalidatedScopes: [{ unsupported: true }] as never,
  });
  expect(ea.get(checkpoint.scopeId)).toBeUndefined();
  expect(ea.snapshot!()).not.toHaveProperty("invalidatedScopes");
  expect(() =>
    restoreRequestContextCompaction(
      { ...snapshot, checkpoints: [checkpoint] },
      { restoreSuperQuarantine: true },
    ),
  ).toThrow("context_compaction_invalidation_active_checkpoint");
});

test("F2: the next canonical activation returns failure before invoking the executor", async () => {
  const { params, ledger, call } = await fixture(true);
  quarantineProvenUnusableSuperCheckpoint(params);
  const execute = vi.fn(async () => ({
    kind: "terminal" as const,
    outcome: "completed" as const,
    summary: "Must not run.",
  }));
  const executor = containSuperContextFailures(
    { roleId: "worker", execute },
    "delegated.worker",
  );
  const registry = createRoleExecutorRegistry([executor]);
  const before = ledger.current();
  const result = await registry.execute({
    requestId: params.request.requestId,
    context: params.request,
    ledger,
    call,
  });
  expect(result.outcome).toBe("failed");
  expect(result.summary).toContain("context_compaction_scope_invalidated");
  expect(execute).not.toHaveBeenCalled();
  expect(ledger.current()).toBe(before);
  expect(ledger.current().state.capabilityExecutions).toHaveLength(2);
});
