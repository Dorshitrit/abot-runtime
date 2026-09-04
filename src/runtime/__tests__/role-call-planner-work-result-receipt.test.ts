import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  composeRoleCallPlanChildObjective,
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallLedger,
  type RoleCallLedgerCommitResult,
} from "../orchestration/role-calls/index.js";
import { projectRoleCallWorkResultLineage } from "../orchestration/role-calls/work-result-lineage.js";
import type { RoleCallWorkResultReceipt } from "../orchestration/role-calls/work-result-receipt.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";

const PLAN_ITEMS = Object.freeze([
  Object.freeze({
    title: "Inspect the target",
    objective: "Inspect the bounded target and record its current state.",
  }),
  Object.freeze({
    title: "Update the target",
    objective: "Apply the bounded requested change to the target.",
  }),
  Object.freeze({
    title: "Verify the target",
    objective: "Verify the bounded target after the requested change.",
  }),
]);

function createLedger(): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "planner-work-receipt-request",
    policy: {
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

async function commit(
  ledger: RoleCallLedger,
  command: unknown,
): Promise<Extract<RoleCallLedgerCommitResult, { ok: true }>> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(`role_call_commit_rejected:${result.code}`);
  return result;
}

function selectedObjective(index: number): string {
  const objective = composeRoleCallPlanChildObjective(
    [PLAN_ITEMS[index]!],
    ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  );
  if (!objective) throw new Error("plan_child_objective_missing");
  return objective;
}

function exactCapabilityResult(summary: string) {
  return Object.freeze({
    kind: "generic_capability_result_v1" as const,
    authority: "capability_adapter" as const,
    status: "executed" as const,
    ok: true,
    payload: Object.freeze({
      outcome: "succeeded" as const,
      observedEffect: "observation" as const,
      summary,
    }),
  });
}

async function settleObservation(
  ledger: RoleCallLedger,
  callId: string,
  capabilityId: string,
): Promise<string> {
  const call = ledger
    .current()
    .state.calls.find((candidate) => candidate.callId === callId);
  if (!call) throw new Error("active_call_missing");
  const begun = await commit(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId,
    invocationAttempt: call.activationCount,
    capabilityId,
    declaredEffect: "observation",
    intent: "Observe the bounded target.",
    controlsJson: "{}",
  });
  if (begun.effect.type !== "capability_execution_begun") {
    throw new Error("capability_execution_not_begun");
  }
  const summary = `Observed through ${capabilityId}.`;
  await commit(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId,
    executionId: begun.effect.executionId,
    outcome: "succeeded",
    observedEffect: "observation",
    summary,
    exactResult: exactCapabilityResult(summary),
  });
  return begun.effect.executionId;
}

async function returnWorker(
  ledger: RoleCallLedger,
  callerCallId: string,
  childCallId: string,
  outcome: "completed" | "failed",
  summary: string,
): Promise<void> {
  await commit(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId,
    childCallId,
    outcome,
    summary,
  });
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("Planner work-result receipt lineage", () => {
  test("snapshots done, blocked, and pending items from only its subtree", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });

    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Observe an unrelated sibling target.",
    });
    const unrelatedExecutionId = await settleObservation(
      ledger,
      "call-2",
      "example.unrelated",
    );
    await returnWorker(
      ledger,
      "call-1",
      "call-2",
      "completed",
      "The unrelated sibling observation is complete.",
    );

    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Coordinate the bounded three-item target plan.",
    });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-3",
      roleId: "worker",
      objective: selectedObjective(0),
      plannerPlan: {
        mode: "declare",
        plan: {
          summary: "Inspect, update, and verify the bounded target.",
          items: PLAN_ITEMS,
        },
        selectedItemIndexes: [0],
      },
    });
    const doneExecutionId = await settleObservation(
      ledger,
      "call-4",
      "example.inspect",
    );
    await returnWorker(
      ledger,
      "call-3",
      "call-4",
      "completed",
      "The target inspection is complete.",
    );

    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-3",
      roleId: "worker",
      objective: selectedObjective(1),
      dependencyResultRefs: ["result-2"],
      plannerPlan: {
        mode: "select",
        itemIds: ["plan-call-3-item-2"],
      },
    });
    const blockedExecutionId = await settleObservation(
      ledger,
      "call-5",
      "example.update",
    );
    await returnWorker(
      ledger,
      "call-3",
      "call-5",
      "failed",
      "The target update is blocked.",
    );

    const sourceRevision = ledger.current().revision;
    const returnedPlanner = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-3",
      outcome: "failed",
      summary: "The bounded plan is not fully complete.",
    });
    const receipt = returnedPlanner.head.state.results.at(-1)
      ?.receipt as RoleCallWorkResultReceipt | undefined;

    expect(receipt).toEqual({
      kind: "work_result_v1",
      producerCallId: "call-3",
      callerCallId: "call-1",
      sourceRevision,
      lineageFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      plannerPlanRef: {
        planId: "plan-call-3",
        planVersion: 1,
      },
    });
    if (!receipt) throw new Error("planner_work_result_receipt_missing");
    const lineage = projectRoleCallWorkResultLineage({
      state: returnedPlanner.head.state,
      receipt,
    });
    expect(lineage).toEqual({
      kind: "work_result_lineage_v1",
      lineageFingerprint: receipt.lineageFingerprint,
      capabilityExecutionIds: [doneExecutionId, blockedExecutionId],
      planner: {
        planId: "plan-call-3",
        planVersion: 1,
        items: [
          {
            itemId: "plan-call-3-item-1",
            status: "done",
            resultRef: "result-2",
          },
          {
            itemId: "plan-call-3-item-2",
            status: "blocked",
            resultRef: "result-3",
          },
          {
            itemId: "plan-call-3-item-3",
            status: "pending",
            resultRef: null,
          },
        ],
      },
    });
    expect(lineage).not.toMatchObject({
      capabilityExecutionIds: expect.arrayContaining([
        unrelatedExecutionId,
      ]),
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(lineage)).toBe(true);
  });
});
