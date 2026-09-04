import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createRoleCallLedger,
  projectRoleChildReturnContext,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  validateRoleCallCandidate,
  type ExecutionPolicyAuthoritySnapshot,
  type RoleCallLedger,
  type RoleCallLedgerCommitResult,
} from "../orchestration/role-calls/index.js";
import { projectRoleCallWorkResultLineage } from "../orchestration/role-calls/work-result-lineage.js";
import type { RoleCallWorkResultReceipt } from "../orchestration/role-calls/work-result-receipt.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";

function createLedger(
  authority?: ExecutionPolicyAuthoritySnapshot,
): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "work-receipt-request",
    policy: {
      ...(authority ? { authority } : {}),
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 8,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
}

async function apply(
  ledger: RoleCallLedger,
  command: unknown,
): Promise<RoleCallLedgerCommitResult> {
  return ledger.apply({ expectedHead: ledger.current(), command });
}

async function commit(
  ledger: RoleCallLedger,
  command: unknown,
): Promise<Extract<RoleCallLedgerCommitResult, { ok: true }>> {
  const result = await apply(ledger, command);
  if (!result.ok) throw new Error(`role_call_commit_rejected:${result.code}`);
  return result;
}

async function openChild(
  ledger: RoleCallLedger,
  roleId: "planner" | "worker",
): Promise<void> {
  await commit(ledger, { authority: "runtime", type: "create_root" });
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId,
    objective: `Complete the bounded ${roleId} assignment.`,
  });
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("runtime-owned work-result receipts", () => {
  test("creates and projects one canonical receipt when a Worker returns", async () => {
    const ledger = createLedger();
    await openChild(ledger, "worker");
    const sourceRevision = ledger.current().revision;

    const returned = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-2",
      outcome: "completed",
      summary: "The bounded work is complete.",
    });

    const expectedReceipt = {
      kind: "work_result_v1",
      producerCallId: "call-2",
      callerCallId: "call-1",
      sourceRevision,
      lineageFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    };
    const receipt = returned.head.state.results[0]?.receipt as
      | RoleCallWorkResultReceipt
      | undefined;
    expect(returned.head.state.results[0]).toMatchObject({
      resultRef: "result-1",
      roleId: "worker",
      receipt: expectedReceipt,
    });
    expect(projectRoleChildReturnContext(ledger, returned)).toMatchObject({
      returnedResultRef: "result-1",
      completedChildren: [{ receipt: expectedReceipt }],
    });
    if (!receipt) throw new Error("work_result_receipt_missing");
    expect(
      projectRoleCallWorkResultLineage({
        state: returned.head.state,
        receipt,
      }),
    ).toEqual({
      kind: "work_result_lineage_v1",
      lineageFingerprint: receipt.lineageFingerprint,
      capabilityExecutionIds: [],
    });
    expect(
      projectRoleCallWorkResultLineage({
        state: returned.head.state,
        receipt: {
          ...receipt,
          lineageFingerprint: `sha256:${"0".repeat(64)}`,
        },
      }),
    ).toBeNull();
    expect(Object.isFrozen(returned.head.state.results[0]?.receipt)).toBe(true);
  });

  test("rejects a forged work receipt and generates its own on retry", async () => {
    const ledger = createLedger();
    await openChild(ledger, "worker");
    const before = ledger.current();
    const forgedReceipt = {
      kind: "work_result_v1",
      producerCallId: "call-999",
      callerCallId: "call-999",
      sourceRevision: before.revision,
      lineageFingerprint: `sha256:${"9".repeat(64)}`,
    };

    const rejected = await apply(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-2",
      outcome: "completed",
      summary: "The bounded work is complete.",
      receipt: forgedReceipt,
    });

    expect(rejected).toMatchObject({
      ok: false,
      status: "rejected",
      code: "invalid_command",
    });
    expect(ledger.current()).toBe(before);

    const returned = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-2",
      outcome: "completed",
      summary: "The bounded work is complete.",
    });
    expect(returned.head.state.results[0]?.receipt).toEqual({
      kind: "work_result_v1",
      producerCallId: "call-2",
      callerCallId: "call-1",
      sourceRevision: before.revision,
      lineageFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
  });

  test.each(["planner", "worker"] as const)(
    "rejects a stored Supervisor-policy %s result without its canonical receipt or lineage",
    async (roleId) => {
      const ledger = createLedger();
      await openChild(ledger, roleId);
      const returned = await commit(ledger, {
        authority: "runtime",
        type: "return_child",
        callerCallId: "call-1",
        childCallId: "call-2",
        outcome: "completed",
        summary: "The bounded assignment is complete.",
      });
      expect(
        validateRoleCallCandidate({
          state: returned.head.state,
          policy: returned.head.policy,
        }),
      ).toEqual([]);

      const missingReceipt = structuredClone(returned.head.state);
      delete (
        missingReceipt.results as unknown as Array<{ receipt?: unknown }>
      )[0]?.receipt;
      expect(
        validateRoleCallCandidate({
          state: missingReceipt,
          policy: returned.head.policy,
        }),
      ).toContainEqual({
        code: "invalid_role_call_result_owner",
        path: "state.results.result-1",
      });

      const inconsistentLineage = structuredClone(returned.head.state);
      const receipt = (
        inconsistentLineage.results as unknown as Array<{
          receipt?: { lineageFingerprint: string };
        }>
      )[0]?.receipt;
      if (!receipt) throw new Error("work_result_receipt_missing");
      receipt.lineageFingerprint = `sha256:${"0".repeat(64)}`;
      expect(
        validateRoleCallCandidate({
          state: inconsistentLineage,
          policy: returned.head.policy,
        }),
      ).toContainEqual({
        code: "invalid_role_call_result_owner",
        path: "state.results.result-1",
      });
    },
  );

  test("does not create a work receipt under Execution Agent authority", async () => {
    const ledger = createLedger(EXECUTION_AGENT_V1_EXECUTION_POLICY.authority);
    await openChild(ledger, "planner");

    const returned = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-2",
      outcome: "completed",
      summary: "The passive planning advisory is complete.",
    });

    expect(returned.head.state.results[0]).not.toHaveProperty("receipt");
    expect(
      projectRoleChildReturnContext(ledger, returned).completedChildren[0],
    ).not.toHaveProperty("receipt");
  });
});
