import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createRoleCallLedger,
  composeRoleCallPlanChildObjective,
  latestRolePlanSteeringVersion,
  projectRoleChildReturnContext,
  projectRoleCallWorkResultLineage,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  validateRoleCallCandidate,
  type RoleCallLedger,
  type RoleCallPolicy,
} from "../orchestration/role-calls/index.js";
import { captureRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { projectPlannerDecisionPlanContext } from "../steps/planner-decision/plan.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";

const policy: RoleCallPolicy = {
  authority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  limits: {
    maxDepth: 4,
    maxCalls: 12,
    maxCapabilityExecutions: 16,
    maxObjectiveChars: 8192,
    maxResultChars: 8192,
    maxResponseChars: 65536,
  },
};
const items = [
  { title: "First", objective: "Create the first artifact." },
  { title: "Second", objective: "Create the second artifact." },
  { title: "Third", objective: "Create the third artifact." },
];
const objective = (item: (typeof items)[number]) =>
  composeRoleCallPlanChildObjective([item], 8192)!;
const createLedger = (override = policy) =>
  createRoleCallLedger({ requestId: "worker-steering", policy: override });
async function commit(ledger: RoleCallLedger, command: unknown) {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  expect(result).toMatchObject({ ok: true, status: "committed" });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result;
}
async function root(ledger: RoleCallLedger) {
  await commit(ledger, { authority: "runtime", type: "create_root" });
}
async function openWorker(
  ledger: RoleCallLedger,
  workerSteeringVersion?: number,
) {
  await root(ledger);
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "worker",
    objective: "Create the artifact.",
    ...(workerSteeringVersion === undefined ? {} : { workerSteeringVersion }),
  });
}
const returned = (
  childCallId: string,
  callerCallId: string,
  steeringVersion?: number,
) => ({
  authority: "runtime",
  type: "return_child",
  childCallId,
  callerCallId,
  outcome: "yielded",
  summary: "Control returned for the new user update.",
  ...(steeringVersion === undefined ? {} : { steeringVersion }),
});
async function begin(ledger: RoleCallLedger, callId: string) {
  return commit(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId,
    invocationAttempt: ledger
      .current()
      .state.calls.find((call) => call.callId === callId)!.activationCount,
    capabilityId: "write_file",
    declaredEffect: "mutation",
    intent: "Write the requested artifact.",
    controlsJson: "{}",
  });
}
async function settle(
  ledger: RoleCallLedger,
  callId: string,
  executionId: string,
) {
  return commit(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId,
    executionId,
    outcome: "succeeded",
    observedEffect: "mutation",
    summary: "Artifact written.",
    exactResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: { artifact: "one.txt" },
    },
  });
}
async function openPlan(ledger: RoleCallLedger) {
  await root(ledger);
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "planner",
    objective: "Create the requested artifacts.",
  });
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-2",
    roleId: "worker",
    objective: objective(items[0]!),
    workerSteeringVersion: 0,
    plannerPlan: {
      mode: "declare",
      plan: { summary: "Create artifacts", items },
      selectedItemIndexes: [0],
    },
  });
  await commit(ledger, {
    authority: "runtime",
    type: "return_child",
    childCallId: "call-3",
    callerCallId: "call-2",
    outcome: "completed",
    summary: "First complete.",
  });
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-2",
    roleId: "worker",
    objective: objective(items[1]!),
    workerSteeringVersion: 0,
    plannerPlan: { mode: "select", itemIds: ["plan-call-2-item-2"] },
  });
}
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("canonical Worker steering yield", () => {
  test("returns only to the exact caller and preserves completed effects and receipt lineage", async () => {
    const ledger = createLedger();
    await openWorker(ledger, 2);
    await begin(ledger, "call-2");
    await settle(ledger, "call-2", "capability-execution-1");
    const executions = ledger.current().state.capabilityExecutions;
    const result = await commit(ledger, returned("call-2", "call-1", 3));
    expect(result.head.state.activeCallId).toBe("call-1");
    expect(result.head.state.capabilityExecutions).toEqual(executions);
    const projected = projectRoleChildReturnContext(ledger, result)
      .completedChildren[0]!;
    expect(projected).toMatchObject({ outcome: "yielded", steeringVersion: 3 });
    expect(projected.workLineage?.capabilityExecutionIds).toEqual([
      "capability-execution-1",
    ]);
    expect(result.head.state.calls[1]).toMatchObject({
      status: "completed",
      workerSteeringVersion: 2,
    });
    expect(
      validateRoleCallCandidate({ state: result.head.state, policy }),
    ).toEqual([]);
    const receipt = result.head.state.results[0]!.receipt;
    if (receipt?.kind !== "work_result_v1")
      throw new Error("Missing work receipt");
    const tampered = {
      ...result.head.state,
      results: result.head.state.results.map((entry) => ({
        ...entry,
        steeringVersion: 4,
      })),
    };
    expect(
      projectRoleCallWorkResultLineage({ state: tampered, receipt }),
    ).toBeNull();
  });

  test.each([undefined, 0, 2, -1, 2.5])(
    "rejects non-new yielded version %s without changing state",
    async (version) => {
      const ledger = createLedger();
      await openWorker(ledger, 2);
      const head = ledger.current();
      expect(
        await ledger.apply({
          expectedHead: head,
          command: returned("call-2", "call-1", version),
        }),
      ).toMatchObject({ ok: false });
      expect(ledger.current()).toBe(head);
    },
  );

  test("rejects yielded Planner and EA results while preserving ordinary EA behavior", async () => {
    const planner = createLedger();
    await root(planner);
    await commit(planner, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Coordinate work.",
    });
    expect(
      await planner.apply({
        expectedHead: planner.current(),
        command: returned("call-2", "call-1", 1),
      }),
    ).toMatchObject({ ok: false });
    const ea = createLedger({
      ...policy,
      authority: {
        id: "execution-agent-v1",
        version: 1,
        definitionHash: `sha256:${"a".repeat(64)}`,
        rootContractId: "execution_agent",
        availableSubordinateContractIds: ["worker"],
        capabilityAuthorities: ["root", "worker"],
      },
    });
    await openWorker(ea);
    expect(
      await ea.apply({
        expectedHead: ea.current(),
        command: returned("call-2", "call-1", 1),
      }),
    ).toMatchObject({ ok: false });
    await commit(ea, { ...returned("call-2", "call-1"), outcome: "completed" });
  });

  test("retires unfinished plan items without falsifying completed items, then allows a new bounded remainder", async () => {
    const ledger = createLedger();
    await openPlan(ledger);
    await commit(ledger, returned("call-4", "call-2", 1));
    const retired = ledger.current().state.plans[0]!;
    expect(retired.itemStates).toEqual([
      { itemId: "plan-call-2-item-1", status: "done", childCallId: "call-3" },
      {
        itemId: "plan-call-2-item-2",
        status: "retired",
        childCallId: "call-4",
        retiredBySteeringVersion: 1,
      },
      {
        itemId: "plan-call-2-item-3",
        status: "retired",
        childCallId: null,
        retiredBySteeringVersion: 1,
      },
    ]);
    expect(latestRolePlanSteeringVersion(retired)).toBe(1);
    const replacement = {
      title: "New scope",
      objective: "Create only the requested replacement artifact.",
    };
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: objective(replacement),
      workerSteeringVersion: 1,
      dependencyResultRefs: ["result-1", "result-2"],
      plannerPlan: {
        mode: "extend",
        extension: { items: [replacement] },
        selectedItemIndexes: [0],
      },
    });
    expect(ledger.current().state.plans[0]!.itemStates.slice(0, 3)).toEqual(
      retired.itemStates,
    );
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-5",
      outcome: "completed",
      summary: "Replacement complete.",
    });
    const final = await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-2",
      outcome: "completed",
      summary: "Updated work complete.",
    });
    const projected = projectRoleChildReturnContext(ledger, final)
      .completedChildren[0]!;
    expect(
      projected.workLineage?.planner?.items.map((item) => item.status),
    ).toEqual(["done", "retired", "retired", "done"]);
  });

  test("retains each retirement version across successive replacement Workers", async () => {
    const ledger = createLedger();
    await openPlan(ledger);
    await commit(ledger, returned("call-4", "call-2", 1));
    const historical = ledger.current().state.plans[0]!.itemStates;
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: objective(items[1]!),
      workerSteeringVersion: 1,
      plannerPlan: {
        mode: "extend",
        extension: { items: [items[1]!] },
        selectedItemIndexes: [0],
      },
    });
    await commit(ledger, returned("call-5", "call-2", 2));
    const state = ledger.current().state;
    const plan = state.plans[0]!;
    expect(plan.itemStates.slice(0, 3)).toEqual(historical);
    expect(plan.itemStates[3]).toMatchObject({
      childCallId: "call-5",
      status: "retired",
      retiredBySteeringVersion: 2,
    });
    expect(latestRolePlanSteeringVersion(plan)).toBe(2);
    const tamperedPlan = {
      ...plan,
      itemStates: plan.itemStates.map((item) =>
        item.status === "retired"
          ? { ...item, retiredBySteeringVersion: 99 }
          : item,
      ),
    };
    expect(
      validateRoleCallCandidate({
        state: { ...state, plans: [tamperedPlan] },
        policy,
      }),
    ).not.toEqual([]);
  });

  test("bounds replacement work by retained plan history as well as remaining calls", async () => {
    const boundedPolicy = {
      ...policy,
      limits: { ...policy.limits, maxCalls: 6 },
    };
    const ledger = createLedger(boundedPolicy);
    await root(ledger);
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Complete the requested artifacts.",
    });
    const originalItems = [
      ...items,
      { title: "Fourth", objective: "Create the fourth artifact." },
    ];
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: objective(originalItems[0]!),
      workerSteeringVersion: 0,
      plannerPlan: {
        mode: "declare",
        plan: { summary: "Original work", items: originalItems },
        selectedItemIndexes: [0],
      },
    });
    await commit(ledger, returned("call-3", "call-2", 1));
    const retired = ledger.current().state.plans[0]!.itemStates;
    const project = () =>
      projectPlannerDecisionPlanContext({
        ledger,
        call: ledger
          .current()
          .state.calls.find((call) => call.callId === "call-2")!,
      });
    expect(project()).toMatchObject({
      mode: "extend",
      maxItems: 2,
      existingItemCount: 4,
    });
    const extensionCommand = (count: number) => ({
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      workerSteeringVersion: 1,
      objective: composeRoleCallPlanChildObjective(
        items.slice(0, count),
        8192,
      )!,
      plannerPlan: {
        mode: "extend",
        extension: { items: items.slice(0, count) },
        selectedItemIndexes: Array.from({ length: count }, (_, index) => index),
      },
    });
    const head = ledger.current();
    const rejected = await ledger.apply({
      expectedHead: head,
      command: extensionCommand(3),
    });
    expect(rejected).toMatchObject({
      ok: false,
      code: "planner_plan_binding_invalid",
    });
    expect(ledger.current()).toBe(head);
    await commit(ledger, extensionCommand(2));
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-4",
      outcome: "completed",
      summary: "Replacement work complete.",
    });
    expect(ledger.current().state.plans[0]!.itemStates.slice(0, 4)).toEqual(
      retired,
    );
    expect(project()).toMatchObject({
      mode: "extend",
      maxItems: 0,
      existingItemCount: 6,
    });
    expect(
      validateRoleCallCandidate({
        state: ledger.current().state,
        policy: boundedPolicy,
      }),
    ).toEqual([]);
  });

  test("allows the caller to finish after retirement without starting replacement work", async () => {
    const ledger = createLedger();
    await openPlan(ledger);
    await commit(ledger, returned("call-4", "call-2", 1));
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-2",
      outcome: "completed",
      summary: "No further work requested.",
    });
    expect(
      ledger.current().state.plans[0]!.itemStates.map((item) => item.status),
    ).toEqual(["done", "retired", "retired"]);
  });

  test.each([undefined, 4])(
    "restores parked Worker binding %s without rewriting legacy checkpoints",
    async (version) => {
      const ledger = createLedger();
      await openWorker(ledger, version);
      await begin(ledger, "call-2");
      const snapshot = JSON.parse(
        JSON.stringify(captureRoleCallLedgerCheckpoint(ledger)),
      );
      const restored = createRoleCallLedger({
        requestId: "worker-steering",
        policy,
        checkpoint: snapshot,
      });
      expect(restored.current().state.calls[1]).toEqual(
        snapshot.state.calls[1],
      );
      await settle(restored, "call-2", "capability-execution-1");
      await commit(restored, returned("call-2", "call-1", (version ?? 0) + 1));
    },
  );

  test("rejects yield while an execution remains unsettled", async () => {
    const ledger = createLedger();
    await openWorker(ledger, 0);
    await begin(ledger, "call-2");
    const head = ledger.current();
    expect(
      await ledger.apply({
        expectedHead: head,
        command: returned("call-2", "call-1", 1),
      }),
    ).toMatchObject({ ok: false });
    expect(ledger.current()).toBe(head);
  });
});
