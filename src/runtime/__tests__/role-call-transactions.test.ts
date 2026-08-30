import { describe, expect, test, vi } from "vitest";

import {
  createRoleCallLedger,
  createRoleCallTransactions,
  resolveRoleCallTransactions,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type RoleCallLedger,
  type RoleCallLedgerCommitResult,
  type RoleCallFrame,
} from "../orchestration/role-calls/index.js";

const ACTION_FINGERPRINT_A = `sha256:${"a".repeat(64)}`;
const ACTION_FINGERPRINT_B = `sha256:${"b".repeat(64)}`;

function createLedger(): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "request-1",
    policy: {
      authority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 16,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
}

describe("role-call transactions", () => {
  test("factory ledger owns one frozen transaction facade", () => {
    const ledger = createLedger();

    expect(ledger.transactions).toBeDefined();
    expect(Object.isFrozen(ledger.transactions)).toBe(true);
    expect(resolveRoleCallTransactions(ledger)).toBe(ledger.transactions);
    expect(resolveRoleCallTransactions(ledger)).toBe(
      resolveRoleCallTransactions(ledger),
    );
  });

  test("legacy fake receives the exact command without hidden cached state", async () => {
    const delegate = createLedger();
    const apply = vi.fn((input: Parameters<RoleCallLedger["apply"]>[0]) =>
      delegate.apply(input),
    );
    const legacyLedger = Object.freeze({
      current: () => delegate.current(),
      commits: delegate.commits,
      apply,
    }) satisfies RoleCallLedger;
    const transactions = resolveRoleCallTransactions(legacyLedger);

    const expectedHead = legacyLedger.current();
    const created = await transactions.createRoot({ expectedHead });

    expect(created.ok).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({
      expectedHead,
      command: {
        authority: "runtime",
        type: "create_root",
      },
    });
  });

  test("narrows valid effects and preserves existing rejection identities", async () => {
    const ledger = createLedger();
    const rooted = await ledger.apply({
      expectedHead: ledger.current(),
      command: { authority: "runtime", type: "create_root" },
    });
    expect(rooted.ok).toBe(true);
    if (!rooted.ok) throw new Error(rooted.code);

    const invalidEffectApply = vi.fn(
      async (): Promise<RoleCallLedgerCommitResult> => rooted,
    );
    const invalidEffect = await createRoleCallTransactions(
      invalidEffectApply,
    ).completeRootResponse({
      expectedHead: rooted.head,
      callId: "call-1",
      response: "Done.",
    });
    expect(invalidEffect).toEqual({
      ok: false,
      issueCode: "root_response_transition_invalid",
      commit: rooted,
    });

    const rejectedCommit: RoleCallLedgerCommitResult = Object.freeze({
      ok: false,
      status: "rejected",
      code: "stale_head",
      head: rooted.head,
    });
    const rejected = await createRoleCallTransactions(
      async () => rejectedCommit,
    ).beginCapabilityExecution({
      expectedHead: rooted.head,
      callId: "call-1",
      invocationAttempt: 1,
      capabilityId: "example.observe",
      declaredEffect: "observation",
      intent: "Read the current value.",
      controlsJson: "{}",
    });
    expect(rejected).toEqual({
      ok: false,
      issueCode: "stale_head",
      commit: rejectedCommit,
    });
  });

  test("applies stale batch admission after head admission without tracking the actions", async () => {
    const ledger = await createActiveWorkerLedger();
    const before = ledger.current();
    const call = requireActiveCall(ledger);
    const entries = observationBatchEntries();
    const isCurrent = vi.fn(() => false);

    const result = await ledger.transactions!.beginCapabilityBatch({
      expectedHead: before,
      callId: call.callId,
      invocationAttempt: call.activationCount,
      entries,
      admission: Object.freeze({ isCurrent }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issueCode);
    expect(result.commit.effect.type).toBe("capability_batch_begun");
    expect(isCurrent).toHaveBeenCalledTimes(1);
    expect(
      result.commit.head.state.capabilityExecutions
        .slice(-entries.length)
        .map((execution) => execution.actionFingerprint),
    ).toEqual([undefined, undefined]);
    expect(result.commit.head.state.operationSupervision).toEqual(
      before.state.operationSupervision,
    );
    expect(entries.map((entry) => entry.actionFingerprint)).toEqual([
      ACTION_FINGERPRINT_A,
      ACTION_FINGERPRINT_B,
    ]);
  });

  test("does not evaluate batch admission when the expected head is stale", async () => {
    const ledger = await createActiveWorkerLedger();
    const staleHead = ledger.current();
    const call = requireActiveCall(ledger);
    const established = await ledger.transactions!.establishWorkingDirectory({
      expectedHead: staleHead,
      callId: call.callId,
      invocationAttempt: call.activationCount,
      workingDirectory: ".",
    });
    expect(established.ok).toBe(true);
    const currentHead = ledger.current();
    const isCurrent = vi.fn(() => false);

    const result = await ledger.transactions!.beginCapabilityBatch({
      expectedHead: staleHead,
      callId: call.callId,
      invocationAttempt: call.activationCount,
      entries: observationBatchEntries(),
      admission: Object.freeze({ isCurrent }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected stale batch begin rejection.");
    expect(result.issueCode).toBe("stale_head");
    expect(isCurrent).not.toHaveBeenCalled();
    expect(ledger.current()).toBe(currentHead);
  });
});

async function createActiveWorkerLedger(): Promise<RoleCallLedger> {
  const ledger = createLedger();
  const rooted = await ledger.transactions!.createRoot({
    expectedHead: ledger.current(),
  });
  if (!rooted.ok) throw new Error(rooted.issueCode);
  const opened = await ledger.transactions!.openChild({
    expectedHead: rooted.commit.head,
    callerCallId: rooted.commit.effect.callId,
    roleId: "worker",
    objective: "Observe two independent bounded targets.",
  });
  if (!opened.ok) throw new Error(opened.issueCode);
  return ledger;
}

function requireActiveCall(ledger: RoleCallLedger): RoleCallFrame {
  const head = ledger.current();
  const call = head.state.calls.find(
    (candidate) => candidate.callId === head.state.activeCallId,
  );
  if (!call) throw new Error("Active role call missing.");
  return call;
}

function observationBatchEntries() {
  return Object.freeze([
    Object.freeze({
      capabilityId: "example.observe-a",
      declaredEffect: "observation" as const,
      intent: "Read the first current value.",
      controlsJson: "{}",
      actionFingerprint: ACTION_FINGERPRINT_A,
    }),
    Object.freeze({
      capabilityId: "example.observe-b",
      declaredEffect: "observation" as const,
      intent: "Read the second current value.",
      controlsJson: "{}",
      actionFingerprint: ACTION_FINGERPRINT_B,
    }),
  ]);
}
