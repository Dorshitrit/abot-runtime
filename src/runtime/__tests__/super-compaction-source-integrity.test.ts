import { expect, test } from "vitest";
import {
  mixedWorkerFixture,
  commit,
} from "./support/super-mixed-compaction-fixture.js";
import {
  assertSuperCompactionCheckpointIntegrity,
  assertSuperCompactionSourceIntegrity,
} from "../context/semantic-compaction/super-source-integrity.js";
import {
  createRequestContextCompactionStore,
  createSemanticCompactionSha256Fingerprint as hash,
} from "../context/semantic-compaction/index.js";
import { captureRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { captureRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { restoreApprovalCompaction } from "../request/approval-wait/super-compaction-restore.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";

const prompt = "Inspect the target.";

test("P2: approval restore accepts canonical mixed bytes and rejects changed legacy payload before continuation", async () => {
  const { ledger, call, store, sources } = await mixedWorkerFixture();
  await commit(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    capabilityId: "files.write",
    declaredEffect: "mutation",
    intent: "Save inspected output.",
    controlsJson: '{"path":"output.txt"}',
    actionFingerprint: hash("new write"),
  });
  const input = {
    requestId: ledger.current().state.requestId,
    prompt,
    ledgerCheckpoint: captureRoleCallLedgerCheckpoint(ledger),
    executionPolicy: resolveRequestExecutionPolicy(),
    snapshot: captureRequestContextCompaction(store),
  };
  expect(restoreApprovalCompaction(input).snapshot?.()).toEqual(input.snapshot);
  const changed = JSON.parse(sources[1]!.content);
  delete changed.acceptedAction;
  const content = JSON.stringify(changed);
  const incompatible = {
    ...input.snapshot,
    checkpoints: [],
    sources: [
      {
        sourceRef: sources[1]!.sourceRef,
        content,
        sourceFingerprint: hash(content),
      },
    ],
  };
  expect(() =>
    restoreApprovalCompaction({ ...input, snapshot: incompatible }),
  ).toThrow("context_compaction_snapshot_source_incompatible");
  expect(store.snapshot?.()).toEqual(input.snapshot);
});

test.each(["missing", "changed", "cross_call", "unknown_family"])(
  "B2: rejects %s source without clearing healthy inventory",
  async (mode) => {
    const { head, checkpoint, sources } = await mixedWorkerFixture();
    const store = createRequestContextCompactionStore();
    const altered = [...sources];
    if (mode === "missing") altered.shift();
    if (mode === "changed") {
      const content = JSON.stringify({
        ...JSON.parse(sources[1]!.content),
        summary: "Invented evidence",
      });
      altered[1] = {
        ...sources[1]!,
        content,
        sourceFingerprint: hash(content),
      };
    }
    if (mode === "cross_call") {
      const message = JSON.parse(sources[0]!.content);
      const record = JSON.parse(message.content);
      record.binding.callId = "call-1";
      message.content = JSON.stringify(record);
      const content = JSON.stringify(message);
      altered[0] = {
        sourceRef: `operation-supervision-evidence:${hash(message.content).slice(7)}`,
        content,
        sourceFingerprint: hash(content),
      };
    }
    if (mode === "unknown_family") {
      const content = JSON.stringify({
        role: "user",
        content: JSON.stringify({
          kind: "invented_evidence",
          callId: "call-2",
        }),
      });
      altered[0] = {
        sourceRef: `operation-supervision-evidence:${hash("unknown").slice(7)}`,
        content,
        sourceFingerprint: hash(content),
      };
    }
    store.registerSources(altered);
    const prior = captureRequestContextCompaction(store);
    const input = { requestId: head.state.requestId, prompt, head, store };
    if (mode === "missing") {
      expect(() =>
        assertSuperCompactionCheckpointIntegrity({ ...input, checkpoint }),
      ).toThrow("context_compaction_source_materialization_missing");
    } else {
      expect(() => assertSuperCompactionSourceIntegrity(input)).toThrow();
    }
    expect(captureRequestContextCompaction(store)).toEqual(prior);
  },
);
