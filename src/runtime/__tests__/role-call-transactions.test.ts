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
} from "../orchestration/role-calls/index.js";

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
});
