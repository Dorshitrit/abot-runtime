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
  type RoleCallLedger,
  type RoleCallLedgerCommand,
  type RoleCallLedgerCommitResult,
  type RoleCallPlanBinding,
} from "../orchestration/role-calls/index.js";
import {
  attachRequestPlannerRoleCallEvents,
  projectRequestPlannerRoleCallCommit,
} from "../request/role-call-planner-events.js";

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
});

describe("request Planner client-event projection from role-call commits", () => {
  test("emits every upfront-bound item as started after the first committed child open", async () => {
    const ledger = await createPlannerLedger();
    const items = [
      ["Inspect runtime state", "Inspect the current runtime state."],
      ["Save runtime report", "Save the observed state in RuntimeStatus.md."],
      [
        "Review runtime report",
        "Audit whether the requested runtime report is complete.",
      ],
    ] as const;
    const opened = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: selectedPlanObjective(items, [0, 1]),
      plannerPlan: declarePlan(items, [0, 1]),
    });

    const events = projectRequestPlannerRoleCallCommit(opened);

    expect(events.map((event) => event.name)).toEqual([
      "planner.plan.created",
      "planner.plan.item.started",
      "planner.plan.item.started",
      "planner.plan.item.planned",
    ]);
    expect(events[0]).toEqual({
      name: "planner.plan.created",
      payload: {
        stage: "development_plan",
        phase: "created",
        plan: {
          summary: "Coordinate the requested runtime report.",
          total: 3,
          completed: 0,
          blocked: 0,
          pending: 1,
          inProgress: 2,
          items: [
            {
              id: "plan-call-2-item-1",
              title: "Inspect runtime state",
              status: "in_progress",
              order: 1,
              total: 3,
            },
            {
              id: "plan-call-2-item-2",
              title: "Save runtime report",
              status: "in_progress",
              order: 2,
              total: 3,
            },
            {
              id: "plan-call-2-item-3",
              title: "Review runtime report",
              status: "pending",
              order: 3,
              total: 3,
            },
          ],
        },
      },
    });
    expect(events[1]).toMatchObject({
      name: "planner.plan.item.started",
      payload: {
        stage: "development_plan",
        phase: "created",
        item: {
          id: "plan-call-2-item-1",
          status: "in_progress",
          order: 1,
          total: 3,
        },
        planItemOrder: 1,
        planItemTotal: 3,
        planSummary: "Coordinate the requested runtime report.",
        planTotal: 3,
        planCompleted: 0,
      },
    });
    expect(events[2]).toMatchObject({
      name: "planner.plan.item.started",
      payload: {
        stage: "development_plan",
        phase: "created",
        item: {
          id: "plan-call-2-item-2",
          status: "in_progress",
          order: 2,
          total: 3,
        },
        planItemOrder: 2,
        planItemTotal: 3,
        planSummary: "Coordinate the requested runtime report.",
        planTotal: 3,
        planCompleted: 0,
      },
    });
  });

  test("keeps one stable full plan while committed items advance", async () => {
    const ledger = await createPlannerLedger();
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: "Inspect the current runtime state.",
      plannerPlan: declarePlan([
        ["Inspect runtime state", "Inspect the current runtime state."],
        ["Save runtime report", "Save the observed state in RuntimeStatus.md."],
      ]),
    });
    const returned = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-3",
      outcome: "completed",
      summary: "The runtime is healthy.",
    });

    expect(
      projectRequestPlannerRoleCallCommit(returned).map((event) => event.name),
    ).toEqual(["planner.plan.updated", "planner.plan.item.completed"]);

    const secondOpened = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: "Save the observed state in RuntimeStatus.md.",
      plannerPlan: {
        mode: "select",
        itemIds: ["plan-call-2-item-2"],
      },
    });
    const events = projectRequestPlannerRoleCallCommit(secondOpened);

    expect(events.map((event) => event.name)).toEqual([
      "planner.plan.updated",
      "planner.plan.item.started",
    ]);
    expect(events[0]).toMatchObject({
      payload: {
        plan: {
          total: 2,
          completed: 1,
          blocked: 0,
          pending: 0,
          inProgress: 1,
          items: [
            {
              id: "plan-call-2-item-1",
              status: "done",
              order: 1,
              total: 2,
            },
            {
              id: "plan-call-2-item-2",
              status: "in_progress",
              order: 2,
              total: 2,
            },
          ],
        },
      },
    });
    expect(JSON.stringify(events)).not.toContain("item.planned");
  });

  test("projects every upfront-bound item completed atomically by one child return", async () => {
    const ledger = await createPlannerLedger();
    const items = [
      ["Inspect runtime state", "Inspect the current runtime state."],
      ["Save runtime report", "Save the observed state in RuntimeStatus.md."],
      [
        "Review runtime report",
        "Audit whether the requested runtime report is complete.",
      ],
    ] as const;
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: selectedPlanObjective(items, [0, 1, 2]),
      plannerPlan: declarePlan(items, [0, 1, 2]),
    });
    const returned = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-3",
      outcome: "completed",
      summary: "The worker established the complete requested runtime report.",
    });
    const events = projectRequestPlannerRoleCallCommit(returned);

    expect(events.map((event) => event.name)).toEqual([
      "planner.plan.updated",
      "planner.plan.item.completed",
      "planner.plan.item.completed",
      "planner.plan.item.completed",
    ]);
    expect(events[0]).toMatchObject({
      payload: {
        phase: "updated",
        plan: {
          total: 3,
          completed: 3,
          blocked: 0,
          pending: 0,
          inProgress: 0,
        },
      },
    });
    expect(
      events.slice(1).map((event) => (event.payload.item as { id: string }).id),
    ).toEqual([
      "plan-call-2-item-1",
      "plan-call-2-item-2",
      "plan-call-2-item-3",
    ]);
    expect(events.slice(1).map((event) => event.payload.planCompleted)).toEqual(
      [3, 3, 3],
    );
  });

  test("projects only an explicit committed plan extension", async () => {
    const ledger = await createPlannerLedger();
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: "Inspect the current runtime state.",
      plannerPlan: declarePlan([
        ["Inspect runtime state", "Inspect the current runtime state."],
      ]),
    });
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-3",
      outcome: "completed",
      summary: "The runtime state is established.",
    });
    const extended = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: "Resolve the newly established completion gap.",
      dependencyResultRefs: ["result-1"],
      plannerPlan: {
        mode: "extend",
        extension: {
          items: [
            {
              title: "Resolve completion gap",
              objective: "Resolve the newly established completion gap.",
            },
            {
              title: "Recheck runtime report",
              objective:
                "Audit whether the remediated runtime report is complete.",
            },
          ],
        },
        selectedItemIndexes: [0],
      },
    });

    const events = projectRequestPlannerRoleCallCommit(extended);
    expect(events.map((event) => event.name)).toEqual([
      "planner.plan.updated",
      "planner.plan.item.started",
      "planner.plan.item.planned",
    ]);
    expect(events[0]).toMatchObject({
      payload: {
        plan: {
          total: 3,
          completed: 1,
          pending: 1,
          inProgress: 1,
          items: [
            {
              id: "plan-call-2-item-1",
              status: "done",
              order: 1,
              total: 3,
            },
            {
              id: "plan-call-2-item-2",
              status: "in_progress",
              order: 2,
              total: 3,
            },
            {
              id: "plan-call-2-item-3",
              status: "pending",
              order: 3,
              total: 3,
            },
          ],
        },
      },
    });
  });

  test("maps every upfront-bound item to blocked atomically after a failed child return", async () => {
    const ledger = await createPlannerLedger();
    const items = [
      ["Perform bounded mutation", "Perform one bounded mutation."],
      ["Verify bounded mutation", "Verify the bounded mutation result."],
    ] as const;
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: selectedPlanObjective(items, [0, 1]),
      plannerPlan: declarePlan(items, [0, 1]),
    });
    const returned = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-3",
      outcome: "failed",
      summary: "The mutation could not be completed.",
    });

    const events = projectRequestPlannerRoleCallCommit(returned);

    expect(events.map((event) => event.name)).toEqual([
      "planner.plan.updated",
      "planner.plan.item.blocked",
      "planner.plan.item.blocked",
    ]);
    expect(events[0]).toMatchObject({
      payload: {
        plan: {
          completed: 0,
          blocked: 2,
          inProgress: 0,
          items: [
            { id: "plan-call-2-item-1", status: "blocked" },
            { id: "plan-call-2-item-2", status: "blocked" },
          ],
        },
      },
    });
    expect(
      events.slice(1).map((event) => (event.payload.item as { id: string }).id),
    ).toEqual(["plan-call-2-item-1", "plan-call-2-item-2"]);
  });

  test("does not replace the top-level client plan with a nested Planner", async () => {
    const ledger = createLedger("nested-planner-events");
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Coordinate the top-level process.",
    });
    const topLevelChild = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "planner",
      objective: "Coordinate one nested sub-process.",
      plannerPlan: declarePlan([
        ["Coordinate nested process", "Coordinate one nested sub-process."],
      ]),
    });
    expect(
      projectRequestPlannerRoleCallCommit(topLevelChild).map(
        (event) => event.name,
      ),
    ).toEqual(["planner.plan.created", "planner.plan.item.started"]);
    const nestedChild = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-3",
      roleId: "worker",
      objective: "Perform one nested outcome.",
      plannerPlan: {
        mode: "declare",
        plan: {
          summary: "Coordinate one nested sub-process.",
          items: [
            {
              title: "Perform nested outcome",
              objective: "Perform one nested outcome.",
            },
          ],
        },
        selectedItemIndexes: [0],
      },
    });

    expect(projectRequestPlannerRoleCallCommit(nestedChild)).toEqual([]);
  });
});

describe("request Planner client-event attachment", () => {
  test("emits the existing event order from the exact canonical commit", async () => {
    configureDebugLogger({ enabled: true });
    const ledger = await createPlannerLedger();
    const onEvent = vi.fn();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    attachRequestPlannerRoleCallEvents({ ledger, onEvent });
    const secretObjective = "SECRET_OBJECTIVE_MUST_NOT_ENTER_DIAGNOSTICS";
    let result: RoleCallLedgerCommitResult;
    let logs: Record<string, unknown>[] = [];
    try {
      result = await ledger.apply({
        expectedHead: ledger.current(),
        command: {
          authority: "active_role",
          type: "open_child",
          callerCallId: "call-2",
          roleId: "worker",
          objective: secretObjective,
          plannerPlan: declarePlan([
            ["Perform secret outcome", secretObjective],
          ]),
        },
      });
      logs = consoleLog.mock.calls.map(
        ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
      );
    } finally {
      consoleLog.mockRestore();
    }

    expect(result!).toMatchObject({ ok: true, status: "committed" });
    expect(onEvent.mock.calls.map(([name]) => name)).toEqual([
      "planner.plan.created",
      "planner.plan.item.started",
    ]);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.request_planner_events",
          event: "projection.completed",
          requestId: "planner-event-request",
          previousRevision: 2,
          revision: 3,
          effectType: "child_opened",
          plannerCallId: "call-2",
          childCallId: "call-3",
          eventCount: 2,
          eventNames: ["planner.plan.created", "planner.plan.item.started"],
          phase: "created",
          planTotal: 1,
          planCompleted: 0,
          planBlocked: 0,
          planPending: 0,
          planInProgress: 1,
        }),
        expect.objectContaining({
          scope: "runtime.request_planner_events",
          event: "emission.completed",
          requestId: "planner-event-request",
          revision: 3,
          eventCount: 2,
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(secretObjective);
  });

  test("reports an event-sink fault without hiding the committed head", async () => {
    configureDebugLogger({ enabled: true });
    const ledger = await createPlannerLedger();
    const onEvent = vi.fn(() => {
      throw new Error("PRIVATE_EVENT_SINK_FAILURE");
    });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    attachRequestPlannerRoleCallEvents({ ledger, onEvent });
    const previousHead = ledger.current();

    let result: RoleCallLedgerCommitResult;
    let logs: Record<string, unknown>[] = [];
    try {
      result = await ledger.apply({
        expectedHead: previousHead,
        command: {
          authority: "active_role",
          type: "open_child",
          callerCallId: "call-2",
          roleId: "worker",
          objective: "Perform one bounded outcome.",
          plannerPlan: declarePlan([
            ["Perform bounded outcome", "Perform one bounded outcome."],
          ]),
        },
      });
      logs = consoleLog.mock.calls.map(
        ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
      );
    } finally {
      consoleLog.mockRestore();
    }

    expect(result!).toMatchObject({
      ok: false,
      status: "committed_with_fault",
      code: "after_commit_fault",
      previousHead,
      head: { revision: previousHead.revision + 1 },
      effect: {
        type: "child_opened",
        callerCallId: "call-2",
        childCallId: "call-3",
      },
    });
    expect(ledger.current()).toBe(result!.head);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.request_planner_events",
          event: "emission.failed",
          requestId: "planner-event-request",
          revision: 3,
          failureStage: "emit",
          errorType: "Error",
        }),
        expect.objectContaining({
          scope: "runtime.role_calls",
          event: "transition.committed_with_fault",
          requestId: "planner-event-request",
          previousRevision: 2,
          revision: 3,
          effectType: "child_opened",
          faultCode: "after_commit_fault",
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain("PRIVATE_EVENT_SINK_FAILURE");
  });
});

async function createPlannerLedger(): Promise<RoleCallLedger> {
  const ledger = createLedger("planner-event-request");
  await commit(ledger, { authority: "runtime", type: "create_root" });
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "planner",
    objective: "Coordinate the requested runtime report.",
  });
  return ledger;
}

function createLedger(requestId: string): RoleCallLedger {
  return createRoleCallLedger({
    requestId,
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

function declarePlan(
  items: readonly (readonly [title: string, objective: string])[],
  selectedItemIndexes: readonly number[] = [0],
): RoleCallPlanBinding {
  return {
    mode: "declare",
    plan: {
      summary: "Coordinate the requested runtime report.",
      items: items.map(([title, objective]) => ({ title, objective })),
    },
    selectedItemIndexes,
  };
}

function selectedPlanObjective(
  items: readonly (readonly [title: string, objective: string])[],
  selectedItemIndexes: readonly number[],
): string {
  const selected = new Set(selectedItemIndexes);
  const objective = composeRoleCallPlanChildObjective(
    items
      .filter((_item, index) => selected.has(index))
      .map(([title, itemObjective]) => ({
        title,
        objective: itemObjective,
      })),
    ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  );
  if (!objective) throw new Error("test_plan_objective_invalid");
  return objective;
}

async function commit(
  ledger: RoleCallLedger,
  command: RoleCallLedgerCommand,
): Promise<Extract<RoleCallLedgerCommitResult, { ok: true }>> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) {
    throw new Error(`test_role_call_commit_failed:${result.code}`);
  }
  return result;
}
