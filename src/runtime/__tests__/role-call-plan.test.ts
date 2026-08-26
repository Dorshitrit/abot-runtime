import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  composeRoleCallPlanChildObjective,
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type RoleCallLedger,
  type RoleCallLedgerCommitResult,
  type RoleCallPolicy,
} from "../orchestration/role-calls/index.js";

const PLAN_SUMMARY = "Inspect, update, and verify the requested target.";
const FIRST_OBJECTIVE = "Inspect the current target and report its state.";
const SECOND_OBJECTIVE = "Apply the requested bounded target update.";
const THIRD_OBJECTIVE = "Audit whether the requested target work is complete.";
const FOURTH_OBJECTIVE = "Publish the verified requested target result.";
const REMEDIATION_OBJECTIVE = "Resolve the newly established completion gap.";

const THREE_PLAN_ITEMS = Object.freeze([
  Object.freeze({
    title: "Inspect current target",
    objective: FIRST_OBJECTIVE,
  }),
  Object.freeze({
    title: "Apply target update",
    objective: SECOND_OBJECTIVE,
  }),
  Object.freeze({
    title: "Review completed work",
    objective: THIRD_OBJECTIVE,
  }),
]);

const FOUR_PLAN_ITEMS = Object.freeze([
  ...THREE_PLAN_ITEMS,
  Object.freeze({
    title: "Publish verified result",
    objective: FOURTH_OBJECTIVE,
  }),
]);

function policy(
  overrides: Partial<RoleCallPolicy["limits"]> = {},
): RoleCallPolicy {
  return {
    authority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
    limits: {
      maxDepth: 4,
      maxCalls: 8,
      maxCapabilityExecutions: 16,
      maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
      maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
      maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      ...overrides,
    },
  };
}

function createLedger(
  overrides: Partial<RoleCallPolicy["limits"]> = {},
): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "role-call-plan-request",
    policy: policy(overrides),
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
  expect(result).toMatchObject({ ok: true, status: "committed" });
  if (!result.ok) throw new Error(result.code);
  return result;
}

async function openPlanner(ledger: RoleCallLedger): Promise<void> {
  await commit(ledger, { authority: "runtime", type: "create_root" });
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "planner",
    objective: "Coordinate the complete requested target work.",
  });
}

function composedObjective(
  items: readonly Readonly<{ title: string; objective: string }>[],
): string {
  const objective = composeRoleCallPlanChildObjective(
    items,
    ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  );
  if (!objective) throw new Error("expected composed plan child objective");
  return objective;
}

function declaration(selectedItemIndexes: readonly number[] = [0]) {
  return {
    mode: "declare",
    plan: {
      summary: PLAN_SUMMARY,
      items: THREE_PLAN_ITEMS,
    },
    selectedItemIndexes,
  };
}

function fourItemDeclaration(selectedItemIndexes: readonly number[] = [0]) {
  return {
    mode: "declare",
    plan: {
      summary: PLAN_SUMMARY,
      items: FOUR_PLAN_ITEMS,
    },
    selectedItemIndexes,
  };
}

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
});

describe("canonical role-call Planner plan", () => {
  test("atomically declares the full plan and binds several selected items to one child", async () => {
    const ledger = createLedger();
    await openPlanner(ledger);

    const opened = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: composedObjective(THREE_PLAN_ITEMS.slice(0, 2)),
      plannerPlan: declaration([0, 1]),
    });

    expect(opened.effect).toEqual({
      type: "child_opened",
      callerCallId: "call-2",
      childCallId: "call-3",
      planItemIds: ["plan-call-2-item-1", "plan-call-2-item-2"],
    });
    expect(opened.head.state.plans).toEqual([
      {
        definition: {
          planId: "plan-call-2",
          plannerCallId: "call-2",
          version: 1,
          summary: PLAN_SUMMARY,
          items: [
            {
              itemId: "plan-call-2-item-1",
              title: "Inspect current target",
              objective: FIRST_OBJECTIVE,
            },
            {
              itemId: "plan-call-2-item-2",
              title: "Apply target update",
              objective: SECOND_OBJECTIVE,
            },
            {
              itemId: "plan-call-2-item-3",
              title: "Review completed work",
              objective: THIRD_OBJECTIVE,
            },
          ],
        },
        itemStates: [
          {
            itemId: "plan-call-2-item-1",
            status: "in_progress",
            childCallId: "call-3",
          },
          {
            itemId: "plan-call-2-item-2",
            status: "in_progress",
            childCallId: "call-3",
          },
          {
            itemId: "plan-call-2-item-3",
            status: "pending",
            childCallId: null,
          },
        ],
      },
    ]);
    expect(Object.isFrozen(opened.head.state.plans)).toBe(true);
    expect(Object.isFrozen(opened.head.state.plans[0])).toBe(true);
    expect(Object.isFrozen(opened.head.state.plans[0]!.definition)).toBe(true);
    expect(Object.isFrozen(opened.head.state.plans[0]!.itemStates)).toBe(true);
  });

  test("settles each multi-item child binding atomically as done or blocked", async () => {
    const ledger = createLedger();
    await openPlanner(ledger);
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: composedObjective(FOUR_PLAN_ITEMS.slice(0, 2)),
      plannerPlan: fourItemDeclaration([0, 1]),
    });

    const firstReturned = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-3",
      outcome: "completed",
      summary: "The first two requested outcomes are established.",
    });
    expect(firstReturned.effect).toEqual({
      type: "child_returned",
      callerCallId: "call-2",
      childCallId: "call-3",
      resultRef: "result-1",
      planItemIds: ["plan-call-2-item-1", "plan-call-2-item-2"],
    });
    expect(firstReturned.head.state.plans[0]?.itemStates.slice(0, 2)).toEqual([
      {
        itemId: "plan-call-2-item-1",
        status: "done",
        childCallId: "call-3",
      },
      {
        itemId: "plan-call-2-item-2",
        status: "done",
        childCallId: "call-3",
      },
    ]);

    const secondOpened = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: composedObjective(FOUR_PLAN_ITEMS.slice(2)),
      dependencyResultRefs: ["result-1"],
      plannerPlan: {
        mode: "select",
        itemIds: ["plan-call-2-item-3", "plan-call-2-item-4"],
      },
    });
    expect(secondOpened.effect).toEqual({
      type: "child_opened",
      callerCallId: "call-2",
      childCallId: "call-4",
      planItemIds: ["plan-call-2-item-3", "plan-call-2-item-4"],
    });
    expect(secondOpened.head.state.plans[0]?.itemStates.slice(2)).toEqual([
      {
        itemId: "plan-call-2-item-3",
        status: "in_progress",
        childCallId: "call-4",
      },
      {
        itemId: "plan-call-2-item-4",
        status: "in_progress",
        childCallId: "call-4",
      },
    ]);

    const secondReturned = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-4",
      outcome: "failed",
      summary: "Neither of the final bound outcomes could be established.",
    });
    expect(secondReturned.effect).toEqual({
      type: "child_returned",
      callerCallId: "call-2",
      childCallId: "call-4",
      resultRef: "result-2",
      planItemIds: ["plan-call-2-item-3", "plan-call-2-item-4"],
    });
    expect(secondReturned.head.state.plans[0]?.itemStates.slice(2)).toEqual([
      {
        itemId: "plan-call-2-item-3",
        status: "blocked",
        childCallId: "call-4",
      },
      {
        itemId: "plan-call-2-item-4",
        status: "blocked",
        childCallId: "call-4",
      },
    ]);
  });

  test("rejects Planner completion until every upfront-bound group settles", async () => {
    const ledger = createLedger();
    await openPlanner(ledger);
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: composedObjective(THREE_PLAN_ITEMS.slice(0, 2)),
      plannerPlan: declaration([0, 1]),
    });
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-3",
      outcome: "completed",
      summary: "The first two outcomes are complete.",
    });

    const beforeIncomplete = ledger.current();
    expect(
      await apply(ledger, {
        authority: "runtime",
        type: "return_child",
        callerCallId: "call-1",
        childCallId: "call-2",
        outcome: "completed",
        summary: "Only part of the plan is complete.",
      }),
    ).toMatchObject({
      ok: false,
      status: "rejected",
      code: "planner_plan_incomplete",
    });
    expect(ledger.current()).toBe(beforeIncomplete);

    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "reviewer",
      objective: THIRD_OBJECTIVE,
      dependencyResultRefs: ["result-1"],
      plannerPlan: {
        mode: "select",
        itemIds: ["plan-call-2-item-3"],
      },
    });
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-4",
      outcome: "completed",
      summary: "The final review outcome is complete.",
    });

    const returned = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-2",
      outcome: "completed",
      summary: "The complete three-item plan is established.",
    });
    expect(returned.effect).toEqual({
      type: "child_returned",
      callerCallId: "call-1",
      childCallId: "call-2",
      resultRef: "result-3",
    });
  });

  test("rejects duplicate, foreign, mismatched, and unowned bindings atomically", async () => {
    const nonPlanner = createLedger();
    await commit(nonPlanner, { authority: "runtime", type: "create_root" });
    await commit(nonPlanner, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Perform one bounded task.",
    });
    const nonPlannerHead = nonPlanner.current();
    expect(
      await apply(nonPlanner, {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-2",
        roleId: "reviewer",
        objective: FIRST_OBJECTIVE,
        plannerPlan: declaration(),
      }),
    ).toMatchObject({
      ok: false,
      status: "rejected",
      code: "planner_plan_binding_invalid",
    });
    expect(nonPlanner.current()).toBe(nonPlannerHead);

    const ledger = createLedger();
    await openPlanner(ledger);
    const beforeDeclaration = ledger.current();
    expect(
      await apply(ledger, {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-2",
        roleId: "worker",
        objective: FIRST_OBJECTIVE,
        plannerPlan: declaration([0, 0]),
      }),
    ).toMatchObject({ ok: false, code: "invalid_command" });
    expect(ledger.current()).toBe(beforeDeclaration);
    expect(
      await apply(ledger, {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-2",
        roleId: "worker",
        objective: FIRST_OBJECTIVE,
        plannerPlan: declaration([0, 99]),
      }),
    ).toMatchObject({
      ok: false,
      code: "planner_plan_binding_invalid",
      issues: expect.arrayContaining([
        {
          code: "planner_plan_declaration_invalid",
          path: "command.plannerPlan",
        },
      ]),
    });
    expect(ledger.current()).toBe(beforeDeclaration);
    expect(
      await apply(ledger, {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-2",
        roleId: "worker",
        objective: FIRST_OBJECTIVE,
        plannerPlan: declaration([0, 1]),
      }),
    ).toMatchObject({
      ok: false,
      code: "planner_plan_binding_invalid",
      issues: expect.arrayContaining([
        {
          code: "planner_plan_selected_objective_mismatch",
          path: "command.objective",
        },
      ]),
    });
    expect(ledger.current()).toBe(beforeDeclaration);

    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: FIRST_OBJECTIVE,
      plannerPlan: declaration(),
    });
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-3",
      outcome: "completed",
      summary: "Inspection completed.",
    });
    const beforeInvalidSelection = ledger.current();
    for (const { command, code } of [
      {
        command: {
          authority: "active_role",
          type: "open_child",
          callerCallId: "call-2",
          roleId: "worker",
          objective: SECOND_OBJECTIVE,
        },
        code: "planner_plan_binding_invalid",
      },
      {
        command: {
          authority: "active_role",
          type: "open_child",
          callerCallId: "call-2",
          roleId: "worker",
          objective: SECOND_OBJECTIVE,
          plannerPlan: {
            mode: "select",
            itemIds: ["plan-call-2-item-2", "plan-call-2-item-2"],
          },
        },
        code: "invalid_command",
      },
      {
        command: {
          authority: "active_role",
          type: "open_child",
          callerCallId: "call-2",
          roleId: "worker",
          objective: SECOND_OBJECTIVE,
          plannerPlan: {
            mode: "select",
            itemIds: ["plan-call-2-item-999"],
          },
        },
        code: "planner_plan_item_unavailable",
      },
      {
        command: {
          authority: "active_role",
          type: "open_child",
          callerCallId: "call-2",
          roleId: "worker",
          objective: FIRST_OBJECTIVE,
          plannerPlan: {
            mode: "select",
            itemIds: ["plan-call-2-item-1"],
          },
        },
        code: "planner_plan_item_unavailable",
      },
    ]) {
      expect(await apply(ledger, command)).toMatchObject({ ok: false, code });
      expect(ledger.current()).toBe(beforeInvalidSelection);
    }
  });

  test("atomically appends and settles several Planner-authored remediation items", async () => {
    const ledger = createLedger();
    await openPlanner(ledger);
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: FIRST_OBJECTIVE,
      plannerPlan: {
        mode: "declare",
        plan: {
          summary: PLAN_SUMMARY,
          items: [THREE_PLAN_ITEMS[0]!],
        },
        selectedItemIndexes: [0],
      },
    });
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-3",
      outcome: "completed",
      summary: "The initial bounded work is complete.",
    });

    const extensionItems = [
      {
        title: "Resolve completion gap",
        objective: REMEDIATION_OBJECTIVE,
      },
      {
        title: "Recheck remediated work",
        objective: THIRD_OBJECTIVE,
      },
    ];
    const extended = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: composedObjective(extensionItems),
      dependencyResultRefs: ["result-1"],
      plannerPlan: {
        mode: "extend",
        extension: { items: extensionItems },
        selectedItemIndexes: [0, 1],
      },
    });

    expect(extended.effect).toEqual({
      type: "child_opened",
      callerCallId: "call-2",
      childCallId: "call-4",
      planItemIds: ["plan-call-2-item-2", "plan-call-2-item-3"],
    });
    expect(extended.head.state.plans[0]).toEqual({
      definition: {
        planId: "plan-call-2",
        plannerCallId: "call-2",
        version: 2,
        summary: PLAN_SUMMARY,
        items: [
          {
            itemId: "plan-call-2-item-1",
            title: "Inspect current target",
            objective: FIRST_OBJECTIVE,
          },
          {
            itemId: "plan-call-2-item-2",
            title: "Resolve completion gap",
            objective: REMEDIATION_OBJECTIVE,
          },
          {
            itemId: "plan-call-2-item-3",
            title: "Recheck remediated work",
            objective: THIRD_OBJECTIVE,
          },
        ],
      },
      itemStates: [
        {
          itemId: "plan-call-2-item-1",
          status: "done",
          childCallId: "call-3",
        },
        {
          itemId: "plan-call-2-item-2",
          status: "in_progress",
          childCallId: "call-4",
        },
        {
          itemId: "plan-call-2-item-3",
          status: "in_progress",
          childCallId: "call-4",
        },
      ],
    });

    const returned = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-4",
      outcome: "completed",
      summary: "Both remediation outcomes are complete.",
    });
    expect(returned.effect).toEqual({
      type: "child_returned",
      callerCallId: "call-2",
      childCallId: "call-4",
      resultRef: "result-2",
      planItemIds: ["plan-call-2-item-2", "plan-call-2-item-3"],
    });
    expect(returned.head.state.plans[0]?.itemStates.slice(1)).toEqual([
      {
        itemId: "plan-call-2-item-2",
        status: "done",
        childCallId: "call-4",
      },
      {
        itemId: "plan-call-2-item-3",
        status: "done",
        childCallId: "call-4",
      },
    ]);
  });

  test("keeps multi-binding diagnostics structured and excludes authored text", async () => {
    configureDebugLogger({ enabled: true });
    const ledger = createLedger();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    let logs: Record<string, unknown>[] = [];
    try {
      await openPlanner(ledger);
      await commit(ledger, {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-2",
        roleId: "worker",
        objective: composedObjective(THREE_PLAN_ITEMS.slice(0, 2)),
        plannerPlan: declaration([0, 1]),
      });
      await apply(ledger, {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-2",
        roleId: "worker",
        objective: composedObjective(THREE_PLAN_ITEMS.slice(1)),
        plannerPlan: declaration([1, 2]),
      });
      await commit(ledger, {
        authority: "runtime",
        type: "return_child",
        callerCallId: "call-2",
        childCallId: "call-3",
        outcome: "completed",
        summary: "Both bound outcomes are complete.",
      });
      logs = consoleLog.mock.calls.map(
        ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
      );
    } finally {
      consoleLog.mockRestore();
    }

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.role_calls",
          event: "child.opened",
          callId: "call-3",
          planId: "plan-call-2",
          planItemIds: ["plan-call-2-item-1", "plan-call-2-item-2"],
          planItemBindingCount: 2,
          planItemCount: 3,
          planSummaryLength: PLAN_SUMMARY.length,
        }),
        expect.objectContaining({
          scope: "runtime.role_calls",
          event: "transition.rejected",
          commandType: "open_child",
          rejectionCode: "caller_not_active",
          attemptedPlanMode: "declare",
          attemptedPlanItemCount: 3,
          attemptedPlanSummaryLength: PLAN_SUMMARY.length,
          attemptedSelectedItemIndexes: [1, 2],
        }),
        expect.objectContaining({
          scope: "runtime.role_calls",
          event: "child.returned",
          callId: "call-3",
          planItemIds: ["plan-call-2-item-1", "plan-call-2-item-2"],
          settledPlanItemCount: 2,
        }),
      ]),
    );
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(PLAN_SUMMARY);
    expect(serialized).not.toContain(FIRST_OBJECTIVE);
    expect(serialized).not.toContain(SECOND_OBJECTIVE);
    expect(serialized).not.toContain(THIRD_OBJECTIVE);
  });
});
