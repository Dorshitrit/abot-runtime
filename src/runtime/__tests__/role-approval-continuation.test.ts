import { describe, expect, test } from "vitest";
import {
  createRoleCallLedger,
  resolveRoleCallTransactions,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallLedger,
  type RoleCallFrame,
} from "../orchestration/role-calls/index.js";
import {
  captureRoleCallLedgerCheckpoint,
  restoreRoleCallLedgerCheckpoint,
} from "../orchestration/role-calls/checkpoint.js";
import {
  createRoleExecutorRegistry,
  type RoleExecutorInput,
} from "../orchestration/role-executors/index.js";
import {
  isRoleApprovalWait,
  type RoleApprovalWait,
} from "../orchestration/role-executors/approval-continuation.js";
import { createEnteredChildInvocation } from "../orchestration/role-executors/child-invocation/entered-child.js";
import {
  createRoleApprovalContinuation,
  validateRequestApprovalContinuation,
  type RequestApprovalContinuation,
} from "../request/approval-continuation.js";

const requestId = "approval-call-chain";
const fingerprint = `sha256:${"a".repeat(64)}`;
const policy = {
  limits: {
    maxDepth: 12,
    maxCalls: 48,
    maxCapabilityExecutions: 96,
    maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
    maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
    maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
  },
};
type Context = { trace: string[] };

function registry() {
  return createRoleExecutorRegistry<Context>([
    {
      roleId: "planner",
      async execute(input) {
        input.context.trace.push("planner");
        if (!input.continuation)
          return {
            kind: "invoke_role",
            roleId: "worker",
            objective: "Observe the exact target.",
            plannerPlan: {
              mode: "declare",
              plan: {
                summary: "Observe and review.",
                items: [
                  { title: "Observe", objective: "Observe the exact target." },
                  { title: "Review", objective: "Review the bounded result." },
                ],
              },
              selectedItemIndexes: [0],
            },
          };
        if (input.continuation.kind !== "role_child")
          throw new Error("unexpected planner continuation");
        const returned = input.continuation.commit.effect.childCallId;
        const child = input.ledger
          .current()
          .state.calls.find((call) => call.callId === returned)!;
        if (child.roleId === "worker")
          return {
            kind: "invoke_role",
            roleId: "reviewer",
            objective: "Review the bounded result.",
            plannerPlan: { mode: "select", itemIds: ["plan-call-2-item-2"] },
          };
        return {
          kind: "terminal",
          outcome: "completed",
          summary: "The reviewed result.",
        };
      },
    },
    {
      roleId: "worker",
      async execute(input) {
        input.context.trace.push("worker");
        if (!input.continuation) return parkCapability(input);
        expect(input.continuation.kind).toBe("capability_execution");
        expect(
          input.ledger.current().state.capabilityExecutions[0]?.status,
        ).toBe("settled");
        return {
          kind: "terminal",
          outcome: "completed",
          summary: "The exact observation.",
        };
      },
    },
    {
      roleId: "reviewer",
      async execute(input) {
        input.context.trace.push("reviewer");
        return { kind: "terminal", outcome: "completed", summary: "Reviewed." };
      },
    },
  ]);
}

async function parkCapability(
  input: RoleExecutorInput<Context>,
): Promise<RoleApprovalWait> {
  const begun = await resolveRoleCallTransactions(
    input.ledger,
  ).beginCapabilityExecution({
    expectedHead: input.ledger.current(),
    callId: input.call.callId,
    invocationAttempt: input.call.activationCount,
    capabilityId: "example.observe",
    declaredEffect: "observation",
    intent: "Observe the target.",
    controlsJson: "{}",
    actionFingerprint: fingerprint,
  });
  if (!begun.ok || begun.commit.effect.type !== "capability_execution_begun")
    throw new Error("begin failed");
  return {
    kind: "awaiting_approval",
    callers: [],
    group: {
      kind: "prepared_approval_group_v1",
      requestId,
      callId: input.call.callId,
      invocationAttempt: input.call.activationCount,
      batch: false,
      entries: [
        {
          executionId: begun.commit.effect.executionId,
          capabilityId: "example.observe",
          declaredEffect: "observation",
          intent: "Observe the target.",
          controls: {},
          actionFingerprint: fingerprint,
          snapshot: { exactTarget: "one" },
        },
      ],
    },
  };
}

async function waitingFixture() {
  const ledger = createRoleCallLedger({ requestId, policy });
  const created = await resolveRoleCallTransactions(ledger).createRoot({
    expectedHead: ledger.current(),
  });
  if (!created.ok) throw new Error("root failed");
  const trace: string[] = ["supervisor"];
  const call = ledger.current().state.calls[0]!;
  const result = await registry().invokeChild({
    requestId,
    context: { trace },
    ledger,
    callerCall: call,
    expectedHead: ledger.current(),
    roleId: "planner",
    objective: "Coordinate the bounded result.",
    turnCount: 1,
    allowApprovalWait: true,
  });
  if (!isRoleApprovalWait(result)) throw new Error("expected waiting");
  const continuation: RequestApprovalContinuation = JSON.parse(
    JSON.stringify({
      kind: "request_approval_continuation_v1",
      ledger: captureRoleCallLedgerCheckpoint(ledger),
      callers: result.callers,
      root: { acknowledgementPublished: true, titlePublished: true },
      preparedGroup: result.group,
    }),
  );
  return { ledger, continuation, trace };
}

async function settle(
  ledger: RoleCallLedger,
  continuation: RequestApprovalContinuation,
  approved: boolean,
) {
  const executionId = continuation.preparedGroup.entries[0]!.executionId;
  const result = await resolveRoleCallTransactions(
    ledger,
  ).settleCapabilityExecution({
    expectedHead: ledger.current(),
    callId: continuation.preparedGroup.callId,
    executionId,
    outcome: approved ? "succeeded" : "failed",
    observedEffect: approved ? "observation" : "none",
    summary: approved ? "Observed." : "The user declined.",
    exactResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: approved,
      payload: { target: "one", approved },
    },
  });
  if (!result.ok) throw new Error(`settle failed:${result.issueCode}`);
  return executionId;
}

describe("approval logical continuation", () => {
  test.each([true, false])(
    "unwinds then returns Worker→Planner→Reviewer→Planner→Supervisor after decision=%s",
    async (approved) => {
      const fixture = await waitingFixture();
      expect(fixture.trace).toEqual(["supervisor", "planner", "worker"]);
      expect(fixture.ledger.current().state.results).toHaveLength(0);
      const restored = restoreRoleCallLedgerCheckpoint(
        fixture.continuation.ledger,
        { requestId, policy },
      );
      expect(restored.current()).not.toBe(fixture.ledger.current());
      expect(restored.current().revision).toBe(
        fixture.ledger.current().revision,
      );
      validateRequestApprovalContinuation(fixture.continuation, restored);
      const executionId = await settle(
        restored,
        fixture.continuation,
        approved,
      );
      const result = await registry().invokeChild(
        createEnteredChildInvocation({
          requestId,
          context: { trace: fixture.trace },
          ledger: restored,
          continuation: createRoleApprovalContinuation(fixture.continuation, [
            executionId,
          ]),
        }),
      );
      if (isRoleApprovalWait(result)) throw new Error("unexpected wait");
      fixture.trace.push("supervisor");
      expect(fixture.trace).toEqual([
        "supervisor",
        "planner",
        "worker",
        "worker",
        "planner",
        "reviewer",
        "planner",
        "supervisor",
      ]);
      expect(result.returnCommit.effect.callerCallId).toBe("call-1");
      expect(restored.current().state.calls).toHaveLength(4);
      expect(restored.current().state.capabilityExecutions).toHaveLength(1);
      expect(restored.current().state.results).toHaveLength(3);
      expect(restored.current().state.activeCallId).toBe("call-1");
      expect(restored.current().state.calls[0]?.status).toBe("active");
    },
  );

  test("rejects a modified caller frame before continuation", async () => {
    const { continuation } = await waitingFixture();
    const changed = structuredClone(continuation);
    (changed.callers[0]!.callerCall as { objective: string | null }).objective =
      "another task";
    const ledger = restoreRoleCallLedgerCheckpoint(changed.ledger, {
      requestId,
      policy,
    });
    expect(() => validateRequestApprovalContinuation(changed, ledger)).toThrow(
      "caller_identity_invalid",
    );
    expect(ledger.current().state.results).toHaveLength(0);
  });

  test("rejects a different prepared action and request authority", async () => {
    const { continuation } = await waitingFixture();
    const changed = structuredClone(continuation);
    (
      changed.preparedGroup.entries[0]! as { actionFingerprint: string }
    ).actionFingerprint = `sha256:${"b".repeat(64)}`;
    const ledger = restoreRoleCallLedgerCheckpoint(changed.ledger, {
      requestId,
      policy,
    });
    expect(() => validateRequestApprovalContinuation(changed, ledger)).toThrow(
      "action_mismatch",
    );
    expect(() =>
      restoreRoleCallLedgerCheckpoint(changed.ledger, {
        requestId: "other",
        policy,
      }),
    ).toThrow("request_mismatch");
  });
});
