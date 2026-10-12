import { afterEach, beforeEach, expect, test } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import { restoreApprovalCompaction } from "../request/approval-wait/super-compaction-restore.js";
import { createRoleCallLedger } from "../orchestration/role-calls/index.js";
import { captureRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { createRequestRoleCallPolicy } from "../request/role-call-policy.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { readCompactionEnvelope } from "./support/semantic-compaction-contract-fixture.js";
import {
  APPROVAL_SOURCE_MARKER,
  createExecutionApprovalCompactionFixture,
} from "./support/execution-approval-compaction-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function unrelatedSource() {
  const content = JSON.stringify({
    role: "user",
    content: "Unrelated exact evidence.",
  });
  return {
    sourceRef: "unrelated:evidence",
    sourceFingerprint: hash(content),
    content,
  };
}

test("restores a legacy parked EA request, compacts current evidence, and performs its approved mutation once", async () => {
  const f = await createExecutionApprovalCompactionFixture();
  expect(f.head.state.calls[0]!.status).toBe("waiting_for_capability");
  expect(f.head.state.capabilityExecutions.map(({ status }) => status)).toEqual(
    ["settled", "running"],
  );
  expect(f.performed).not.toHaveBeenCalled();
  const snapshot = f.snapshot();
  const original = JSON.stringify(snapshot);
  const { resumed, store } = await f.resume(snapshot);
  expect(resumed.kind).toBe("completed");
  expect(f.observed).toHaveBeenCalledOnce();
  expect(f.performed).toHaveBeenCalledOnce();
  expect(f.compacted).toHaveLength(1);
  const sources = readCompactionEnvelope(f.compacted[0]!).newSources!;
  const source = sources.find(
    ({ sourceRef }) => sourceRef === snapshot.sources[0]!.sourceRef,
  )!;
  const message = JSON.parse(source.content);
  expect(message).toEqual(f.currentMessage);
  expect(JSON.parse(message.content).result).toMatchObject({
    outcome: "succeeded",
    observedEffect: "observation",
    adapterResult: { result: { output: APPROVAL_SOURCE_MARKER } },
  });
  expect(
    store.snapshot!().sources.find(
      ({ sourceRef }) => sourceRef === source.sourceRef,
    )?.sourceFingerprint,
  ).not.toBe(snapshot.sources[0]!.sourceFingerprint);
  expect(JSON.stringify(snapshot)).toBe(original);
});

test("current snapshots preserve every source and checkpoint unchanged", async () => {
  const f = await createExecutionApprovalCompactionFixture();
  const snapshot = f.snapshot(false);
  expect(f.restore(snapshot).snapshot!()).toEqual(snapshot);
  expect(f.performed).not.toHaveBeenCalled();
});

test("invalidates only dependent checkpoints and retains unrelated exact source bodies", async () => {
  const f = await createExecutionApprovalCompactionFixture();
  const legacy = f.snapshot();
  const other = unrelatedSource();
  const healthy = f.checkpoint([other], "unrelated");
  const snapshot = {
    ...legacy,
    sources: [...legacy.sources, other],
    checkpoints: [f.checkpoint([...legacy.sources, other]), healthy],
  };
  const original = JSON.stringify(snapshot);
  expect(f.restore(snapshot).snapshot!()).toEqual({
    kind: "request_context_compaction_v1",
    sources: [other],
    checkpoints: [healthy],
  });
  expect(JSON.stringify(snapshot)).toBe(original);
});

test("removes a verified legacy source even when no checkpoint was committed", async () => {
  const f = await createExecutionApprovalCompactionFixture();
  expect(f.restore({ ...f.snapshot(), checkpoints: [] }).snapshot!()).toEqual({
    kind: "request_context_compaction_v1",
    sources: [],
    checkpoints: [],
  });
});

test.each([
  "bad_hash",
  "changed_raw",
  "unknown_execution",
  "wrong_native_ref",
  "malformed_known_source",
  "changed_canonical",
  "missing_covered_source",
] as const)(
  "rejects %s before the saved approved effect without masking original corruption",
  async (mode) => {
    const f = await createExecutionApprovalCompactionFixture();
    const baseline = f.snapshot(mode !== "changed_canonical");
    let source = baseline.sources[0]!;
    if (mode === "bad_hash")
      source = { ...source, sourceFingerprint: hash("wrong bytes") };
    if (mode === "changed_raw" || mode === "changed_canonical") {
      const message = JSON.parse(source.content);
      const envelope = JSON.parse(message.content);
      if (mode === "changed_raw")
        envelope.result.adapterResult.result.output = "Unbound receipt";
      else envelope.result.outcome = "failed";
      message.content = JSON.stringify(envelope);
      const content = JSON.stringify(message);
      source = { ...source, content, sourceFingerprint: hash(content) };
    }
    if (mode === "unknown_execution")
      source = { ...source, sourceRef: "tool-result:unknown-execution" };
    if (mode === "wrong_native_ref")
      source = { ...source, sourceRef: "unrelated-prefix:unknown-execution" };
    if (mode === "malformed_known_source") {
      const content = "malformed native message";
      source = { ...source, content, sourceFingerprint: hash(content) };
    }
    const snapshot = {
      ...baseline,
      sources: [source],
      checkpoints:
        mode === "missing_covered_source"
          ? [
              {
                ...baseline.checkpoints[0]!,
                sourceDigests: [
                  {
                    ...baseline.checkpoints[0]!.sourceDigests[0]!,
                    sourceFingerprint: hash("missing original source"),
                  },
                ],
              },
            ]
          : [f.checkpoint([source])],
    };
    const before = JSON.stringify(snapshot);
    await expect(f.resume(snapshot)).rejects.toThrow(
      /context_compaction_(source_invalid|snapshot_source_(incompatible|missing))/u,
    );
    expect(f.performed).not.toHaveBeenCalled();
    expect(f.observed).toHaveBeenCalledOnce();
    expect(f.compacted).toEqual([]);
    expect(JSON.stringify(snapshot)).toBe(before);
  },
);

test("a non-EA policy retains the existing snapshot restore behavior", async () => {
  const f = await createExecutionApprovalCompactionFixture();
  const snapshot = f.snapshot();
  const policy = {
    ...f.request.executionPolicy,
    authority: {
      ...f.request.executionPolicy.authority,
      id: "unrelated-policy",
      rootContractId: "unrelated_root",
    },
  };
  const store = restoreApprovalCompaction({
    snapshot,
    ledgerCheckpoint: f.continuation.ledger,
    requestId: f.request.requestId,
    prompt: f.request.prompt,
    executionPolicy: policy,
  });
  expect(store.snapshot!()).toEqual(snapshot);
});

test("preserves a non-root execution source from an unrelated context lane", async () => {
  const policy = {
    ...EXECUTION_AGENT_V1_EXECUTION_POLICY,
    authority: {
      ...EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
      availableSubordinateContractIds: ["worker"] as const,
      capabilityAuthorities: ["root", "worker"] as const,
    },
  };
  const ledger = createRoleCallLedger({
    requestId: "unrelated-child",
    policy: createRequestRoleCallPolicy(policy),
  });
  const commit = async (command: unknown) => {
    const result = await ledger.apply({
      expectedHead: ledger.current(),
      command,
    });
    if (!result.ok) throw new Error(result.code);
  };
  await commit({ authority: "runtime", type: "create_root" });
  await commit({
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "worker",
    objective: "Read a separate source.",
  });
  await commit({
    authority: "active_role",
    type: "begin_capability_execution",
    callId: "call-2",
    invocationAttempt: 1,
    capabilityId: "separate.read",
    declaredEffect: "observation",
    intent: "Read separately.",
    controlsJson: "{}",
  });
  const executionId =
    ledger.current().state.capabilityExecutions[0]!.executionId;
  await commit({
    authority: "runtime",
    type: "settle_capability_execution",
    callId: "call-2",
    executionId,
    outcome: "succeeded",
    observedEffect: "observation",
    summary: "Separate observed source.",
    exactResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: "Separate source.",
    },
  });
  await commit({
    authority: "active_role",
    type: "begin_capability_execution",
    callId: "call-2",
    invocationAttempt: 2,
    capabilityId: "separate.change",
    declaredEffect: "mutation",
    intent: "Await separate approval.",
    controlsJson: "{}",
  });
  const content = JSON.stringify({
    role: "tool",
    toolCallId: executionId,
    content: JSON.stringify({
      kind: "other_role_result",
      result: "Separate source.",
    }),
  });
  const snapshot = {
    kind: "request_context_compaction_v1" as const,
    checkpoints: [],
    sources: [
      {
        sourceRef: `tool-result:${executionId}`,
        sourceFingerprint: hash(content),
        content,
      },
    ],
  };
  expect(
    restoreApprovalCompaction({
      snapshot,
      ledgerCheckpoint: captureRoleCallLedgerCheckpoint(ledger),
      requestId: "unrelated-child",
      prompt: "Original request.",
      executionPolicy: policy,
    }).snapshot!(),
  ).toEqual(snapshot);
});

test("preserves passive quoted result JSON without treating it as native tool authority", async () => {
  const f = await createExecutionApprovalCompactionFixture();
  const current = f.snapshot(false);
  const content = JSON.stringify({
    role: "user",
    content: f.currentMessage.content,
  });
  const quoted = {
    sourceRef: "history:quoted-result",
    content,
    sourceFingerprint: hash(content),
  };
  const snapshot = {
    ...current,
    sources: [...current.sources, quoted],
    checkpoints: [
      ...current.checkpoints,
      f.checkpoint([quoted], "quoted-history"),
    ],
  };
  expect(f.restore(snapshot).snapshot!()).toEqual(snapshot);
});

test("rejects invalidating another request's dependent checkpoint before effects", async () => {
  const f = await createExecutionApprovalCompactionFixture();
  const legacy = f.snapshot();
  const snapshot = {
    ...legacy,
    checkpoints: [{ ...legacy.checkpoints[0]!, requestId: "another-request" }],
  };
  const original = JSON.stringify(snapshot);
  await expect(f.resume(snapshot)).rejects.toThrow(
    "context_compaction_snapshot_source_incompatible",
  );
  expect(f.performed).not.toHaveBeenCalled();
  expect(f.compacted).toEqual([]);
  expect(JSON.stringify(snapshot)).toBe(original);
});
