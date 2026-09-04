import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  composeRoleCallPlanChildObjective,
  createRoleCallLedger,
  projectRoleChildReturnContext,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type RoleCallLedger,
  type RoleCallLedgerCommitResult,
} from "../orchestration/role-calls/index.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { projectPlannerDecisionPlanContext } from "../steps/planner-decision/index.js";
import { buildSupervisorContinuationPart } from "../steps/supervisor-decision/resume.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const PLAN_ITEM = Object.freeze({
  title: "Produce bounded result",
  objective: "Produce one bounded result.",
});

function createLedger(): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "planner-blocked-completion-characterization",
    policy: {
      authority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
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

describe("Planner blocked-result handoff", () => {
  test("preserves blocked work through a normal Planner return without finalizing the request", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Coordinate one bounded result.",
      workingDirectory: ".",
    });
    const workerObjective = composeRoleCallPlanChildObjective(
      [PLAN_ITEM],
      ROLE_CALL_OBJECTIVE_MAX_LENGTH,
    );
    if (!workerObjective) throw new Error("worker_objective_missing");
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: workerObjective,
      plannerPlan: {
        mode: "declare",
        plan: {
          summary: "Produce and establish the bounded result.",
          items: [PLAN_ITEM],
        },
        selectedItemIndexes: [0],
      },
    });
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-3",
      outcome: "failed",
      summary: "The bounded result could not be produced.",
    });
    const blockedHead = ledger.current();
    const plannerCall = blockedHead.state.calls.find(
      ({ callId }) => callId === "call-2",
    );
    if (!plannerCall) throw new Error("planner_call_missing");

    expect(blockedHead.state.plans[0]?.itemStates).toEqual([
      {
        itemId: "plan-call-2-item-1",
        status: "blocked",
        childCallId: "call-3",
      },
    ]);
    expect(projectPlannerDecisionPlanContext({ ledger, call: plannerCall }))
      .toMatchObject({ mode: "extend", existingItemCount: 1 });

    const returned = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-2",
      outcome: "completed",
      summary: "Planner work completed.",
    });

    expect(returned.effect).toEqual({
      type: "child_returned",
      callerCallId: "call-1",
      childCallId: "call-2",
      resultRef: "result-2",
    });
    expect(returned.head.state.results[1]).toMatchObject({
      roleId: "planner",
      outcome: "completed",
    });

    const resume = projectRoleChildReturnContext(ledger, returned);
    const continuation = buildSupervisorContinuationPart({
      resume,
      currentCallId: "call-1",
      currentInvocationAttempt: resume.invocationAttempt,
    });
    expect(continuation.compactMessages).toBeDefined();
    const expectedPlanSnapshot = {
      planId: "plan-call-2",
      planVersion: 1,
      items: [
        {
          itemId: "plan-call-2-item-1",
          status: "blocked",
          resultRef: "result-1",
        },
      ],
    };

    for (const messages of [
      continuation.messages,
      continuation.compactMessages!,
    ]) {
      const returnedResults = messages
        .filter(({ role }) => role === "user")
        .map(({ content }) => JSON.parse(content));
      expect(returnedResults).toEqual([
        expect.objectContaining({
          kind: "runtime_child_result",
          callerCallId: "call-1",
          childCallId: "call-2",
          resultRef: "result-2",
          roleId: "planner",
          outcome: "completed",
          summary: "Planner work completed.",
          workReceipt: returned.head.state.results[1]!.receipt,
          workLineage: expect.objectContaining({
            kind: "work_result_lineage_v1",
            planner: expectedPlanSnapshot,
          }),
        }),
      ]);
    }

    expect(ledger.current()).toBe(returned.head);
    expect(returned.head.state).toMatchObject({
      phase: "running",
      activeCallId: "call-1",
      rootResponse: null,
    });
    expect(returned.head.state.calls[0]).toMatchObject({
      callId: "call-1",
      status: "active",
      resultRef: null,
    });
    expect(returned.head.state.plans[0]!.itemStates).toEqual(
      blockedHead.state.plans[0]!.itemStates,
    );
    expect(returned.head.state.results[0]).toMatchObject({
      resultRef: "result-1",
      producerCallId: "call-3",
      roleId: "worker",
      outcome: "failed",
      summary: "The bounded result could not be produced.",
    });
  });
});
