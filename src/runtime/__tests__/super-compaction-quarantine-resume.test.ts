import { expect, test } from "vitest";
import {
  mixedWorkerFixture,
  commit,
} from "./support/super-mixed-compaction-fixture.js";
import { captureRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { captureRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { restoreApprovalCompaction } from "../request/approval-wait/super-compaction-restore.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/index.js";

async function quarantinedSnapshot() {
  const { ledger, call, store, checkpoint } = await mixedWorkerFixture();
  const invalidCheckpoint = {
    ...checkpoint,
    sourceRevision: ledger.current().revision + 100,
  };
  store.commit(invalidCheckpoint);
  const {
    kind: _kind,
    scopeId,
    sourceRevision: _revision,
    sourceDigests: _digests,
    continuation: _continuation,
    ...binding
  } = checkpoint;
  store.quarantineScope!({
    scopeId,
    binding,
    failureCode: "context_compaction_checkpoint_revision_invalid",
  });
  await commit(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    capabilityId: "files.write",
    declaredEffect: "mutation",
    intent: "Save target.",
    controlsJson: "{}",
    actionFingerprint: hash("write"),
  });
  return {
    requestId: ledger.current().state.requestId,
    prompt: "Inspect the target.",
    ledgerCheckpoint: captureRoleCallLedgerCheckpoint(ledger),
    executionPolicy: resolveRequestExecutionPolicy(),
    snapshot: captureRequestContextCompaction(store),
    checkpoint,
  };
}

test("P1: proven quarantine survives approval hydration without discarding source inventory", async () => {
  const input = await quarantinedSnapshot();
  const restored = restoreApprovalCompaction(input);
  expect(restored.snapshot?.()).toEqual(input.snapshot);
  expect(restored.findByCallIds([input.checkpoint.callId])).toEqual([]);
  expect(() => restored.get(input.checkpoint.scopeId)).toThrow(
    "context_compaction_scope_invalidated",
  );
  expect(() => restored.commit(input.checkpoint)).toThrow(
    "context_compaction_scope_invalidated",
  );
  expect(restored.snapshot?.().sources).toEqual(input.snapshot.sources);
});

test.each(["unknown_reason", "foreign_binding", "active_duplicate"])(
  "P2: rejects %s quarantine before approval continuation",
  async (scenario) => {
    const input = await quarantinedSnapshot();
    const snapshot = JSON.parse(JSON.stringify(input.snapshot));
    if (scenario === "unknown_reason")
      snapshot.invalidatedScopes[0].failureCode = "provider_timeout";
    if (scenario === "foreign_binding")
      snapshot.invalidatedScopes[0].binding.callId = "call-unknown";
    if (scenario === "active_duplicate")
      snapshot.checkpoints = [input.checkpoint];
    expect(() => restoreApprovalCompaction({ ...input, snapshot })).toThrow(
      "context_compaction_snapshot_source_incompatible",
    );
  },
);

test("E5: EA keeps existing snapshot restore and ignores SUPER-only quarantine metadata", async () => {
  const input = await quarantinedSnapshot();
  const snapshot = JSON.parse(JSON.stringify(input.snapshot));
  snapshot.invalidatedScopes = [{ invalid: "ignored by existing EA path" }];
  const restored = restoreApprovalCompaction({
    ...input,
    snapshot,
    executionPolicy: resolveRequestExecutionPolicy("execution-agent-v1"),
  });
  expect(restored.snapshot?.()).toEqual({
    kind: "request_context_compaction_v1",
    checkpoints: [],
    sources: snapshot.sources,
  });
});
