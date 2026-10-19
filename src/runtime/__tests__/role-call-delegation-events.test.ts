import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  createRoleCallLedger,
  resolveRoleCallTransactions,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type ExecutionPolicyAuthoritySnapshot,
  type RoleCallLedger,
  type RoleCallLedgerCommand,
} from "../orchestration/role-calls/index.js";
import {
  captureRoleCallLedgerCheckpoint,
  restoreRoleCallLedgerCheckpoint,
} from "../orchestration/role-calls/checkpoint.js";
import { createRoleExecutorRegistry } from "../orchestration/role-executors/index.js";
import { restoreEnteredChild } from "../orchestration/role-executors/child-invocation/entered-child.js";
import { attachRequestRoleDelegationEvents } from "../request/role-call-delegation-events.js";

const requestId = "delegation-events";
const limits = {
  maxDepth: 4,
  maxCalls: 8,
  maxCapabilityExecutions: 8,
  maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
  maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
};

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("committed Supervisor delegation events", () => {
  test.each(["planner", "worker", "reviewer"] as const)(
    "publishes the exact accepted %s assignment once",
    async (roleId) => {
      const { ledger, onEvent } = await createObservedLedger();
      const objective = "  First paragraph.\n\nInspect <target> & report exactly.  ";
      await commit(ledger, {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-1",
        roleId,
        objective,
      });
      expect(onEvent.mock.calls).toEqual([
        [
          "role.delegated",
          {
            callerCallId: "call-1",
            callerRole: "supervisor",
            childCallId: "call-2",
            childRole: roleId,
            objective: objective.trim(),
          },
        ],
      ]);
      await commit(ledger, {
        authority: "runtime",
        type: "return_child",
        callerCallId: "call-1",
        childCallId: "call-2",
        outcome: "completed",
        summary: "The bounded assignment is complete.",
      });
      expect(onEvent).toHaveBeenCalledOnce();
    },
  );

  test("preserves the complete objective at the existing maximum length", async () => {
    const { ledger, onEvent } = await createObservedLedger();
    const objective = "a".repeat(ROLE_CALL_OBJECTIVE_MAX_LENGTH - 5) + "\nend.";
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective,
    });
    expect(onEvent.mock.calls[0]?.[1].objective).toBe(objective);
    expect(objective).toHaveLength(ROLE_CALL_OBJECTIVE_MAX_LENGTH);
  });

  test.each(["", "a".repeat(ROLE_CALL_OBJECTIVE_MAX_LENGTH + 1)])(
    "does not publish a rejected assignment %#",
    async (objective) => {
      const { ledger, onEvent } = await createObservedLedger();
      const head = ledger.current();
      const rejected = await ledger.apply({
        expectedHead: head,
        command: {
          authority: "active_role",
          type: "open_child",
          callerCallId: "call-1",
          roleId: "worker",
          objective,
        },
      });
      expect(rejected.ok).toBe(false);
      expect(ledger.current()).toBe(head);
      expect(onEvent).not.toHaveBeenCalled();
    },
  );

  test("excludes Execution Agent children despite the shared supervisor root role", async () => {
    const { ledger, onEvent } = await createObservedLedger({
      ...SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
      id: "execution-agent-v1",
      rootContractId: "execution_agent",
      capabilityAuthorities: ["root"],
    });
    expect(ledger.current().state.calls[0]?.roleId).toBe("supervisor");
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Propose an advisory graph.",
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  test("excludes the Planner's nested Worker assignment", async () => {
    const { ledger, onEvent } = await createObservedLedger();
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Coordinate the requested report.",
    });
    onEvent.mockClear();
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: "Inspect the report source.",
      plannerPlan: {
        mode: "declare",
        plan: {
          summary: "Prepare the report.",
          items: [{ title: "Inspect", objective: "Inspect the report source." }],
        },
        selectedItemIndexes: [0],
      },
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  test("publishes after the canonical commit and before the child executes", async () => {
    const { ledger, onEvent } = await createObservedLedger();
    const order: string[] = [];
    onEvent.mockImplementation((_name, payload) => {
      const state = ledger.current().state;
      expect(state.activeCallId).toBe(payload.childCallId);
      expect(state.calls[0]?.status).toBe("waiting_for_child");
      expect(state.calls[1]?.objective).toBe(payload.objective);
      order.push("delegated");
    });
    const registry = createRoleExecutorRegistry([
      {
        roleId: "worker",
        async execute() {
          order.push("executed");
          return {
            kind: "terminal",
            outcome: "completed",
            summary: "Observed the requested source.",
          };
        },
      },
    ]);
    const head = ledger.current();
    await registry.invokeChild({
      requestId,
      context: {},
      ledger,
      expectedHead: head,
      callerCall: head.state.calls[0]!,
      roleId: "worker",
      objective: "Observe the requested source.",
      turnCount: 1,
    });
    expect(order).toEqual(["delegated", "executed"]);
    expect(onEvent).toHaveBeenCalledOnce();
  });

  test("does not repeat the event when restoring an already entered child", async () => {
    const { ledger, onEvent } = await createObservedLedger();
    const callerCall = ledger.current().state.calls[0]!;
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: callerCall.callId,
      roleId: "worker",
      objective: "Continue the admitted assignment.",
    });
    expect(onEvent).toHaveBeenCalledOnce();
    const parked = await resolveRoleCallTransactions(ledger).beginCapabilityExecution({
      expectedHead: ledger.current(),
      callId: "call-2",
      invocationAttempt: 1,
      capabilityId: "example.observe",
      declaredEffect: "observation",
      intent: "Continue the admitted observation.",
      controlsJson: "{}",
      actionFingerprint: `sha256:${"a".repeat(64)}`,
    });
    if (!parked.ok) throw new Error("test_delegation_capability_not_parked");
    const checkpoint = JSON.parse(
      JSON.stringify(captureRoleCallLedgerCheckpoint(ledger)),
    );
    const restored = restoreRoleCallLedgerCheckpoint(checkpoint, {
      requestId,
      policy: ledger.current().policy,
    });
    const resumedEvents = vi.fn();
    attachRequestRoleDelegationEvents({
      ledger: restored,
      onEvent: resumedEvents,
    });
    const entered = restoreEnteredChild(restored, {
      callerCall,
      childCallId: "call-2",
      turnCount: 1,
    });
    expect(entered.call.objective).toBe("Continue the admitted assignment.");
    expect(restored.current().state.calls).toHaveLength(2);
    expect(resumedEvents).not.toHaveBeenCalled();
  });

  test.each(["throw", "thenable"] as const)(
    "preserves committed_with_fault when the event sink returns %s",
    async (failure) => {
      const { ledger, onEvent } = await createObservedLedger();
      onEvent.mockImplementation(() => {
        if (failure === "throw") throw new Error("event sink failed");
        return Promise.resolve();
      });
      const head = ledger.current();
      const result = await ledger.apply({
        expectedHead: head,
        command: {
          authority: "active_role",
          type: "open_child",
          callerCallId: "call-1",
          roleId: "worker",
          objective: "Observe the requested source.",
        },
      });
      expect(result).toMatchObject({
        ok: false,
        status: "committed_with_fault",
        code: "after_commit_fault",
        effect: { type: "child_opened", childCallId: "call-2" },
      });
      expect(ledger.current().revision).toBe(head.revision + 1);
      expect(ledger.current().state.activeCallId).toBe("call-2");
      expect(onEvent).toHaveBeenCalledOnce();
    },
  );
});

async function createObservedLedger(
  authority: ExecutionPolicyAuthoritySnapshot =
    SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
) {
  const ledger = createRoleCallLedger({
    requestId,
    policy: { authority, limits },
  });
  const onEvent = vi.fn<
    (name: string, payload: Record<string, unknown>) => void
  >();
  attachRequestRoleDelegationEvents({ ledger, onEvent });
  await commit(ledger, { authority: "runtime", type: "create_root" });
  return { ledger, onEvent };
}

async function commit(
  ledger: RoleCallLedger,
  command: RoleCallLedgerCommand,
) {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(`test_delegation_commit_failed:${result.code}`);
  return result;
}
