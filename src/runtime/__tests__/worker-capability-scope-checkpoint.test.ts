import { expect, test } from "vitest";
import {
  createRoleCallLedger,
  resolveRoleCallTransactions,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
} from "../orchestration/role-calls/index.js";
import {
  captureRoleCallLedgerCheckpoint,
  restoreRoleCallLedgerCheckpoint,
} from "../orchestration/role-calls/checkpoint.js";
import { parsePlannerDecisionOutput } from "../steps/planner-decision/parser.js";
import { parseSupervisorDecisionOutput } from "../steps/supervisor-decision/parser.js";

test.each(["planner", "supervisor"] as const)(
  "%s commits and restores only the normalized Worker selection",
  async (role) => {
    const requestId = `normalized-${role}-scope`;
    const policy = { limits: {
      maxDepth: 3, maxCalls: 5, maxCapabilityExecutions: 4,
      maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
      maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
      maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
    } };
    const ledger = createRoleCallLedger({ requestId, policy });
    const root = await ledger.apply({
      expectedHead: ledger.current(),
      command: { authority: "runtime", type: "create_root" },
    });
    expect(root.ok).toBe(true);
    if (role === "planner") {
      const opened = await ledger.apply({
        expectedHead: ledger.current(),
        command: {
          authority: "active_role", type: "open_child", callerCallId: "call-1",
          roleId: "planner", objective: "Create the requested artifact.",
        },
      });
      expect(opened.ok).toBe(true);
    }
    const availableWorkerCapabilityCatalog = ["read", "write"].map((groupId) => ({
      groupId, memberCount: 1, effects: ["mutation" as const],
    }));
    const decision = {
      action: "invoke_role", roleId: "worker",
      objective: "Create the requested artifact.",
      workerCapabilityScope: { catalogGroupIds: ["write", "read", "write", "read"] },
    };
    const parsed = role === "planner"
      ? parsePlannerDecisionOutput(JSON.stringify({
          decision: {
            action: decision.action, roleId: decision.roleId, workingDirectory: ".",
            workerCapabilityScope: decision.workerCapabilityScope,
            plan: { summary: decision.objective, items: [
              { title: "Create artifact", objective: decision.objective },
            ] },
            selectedItemIndexes: [0],
          },
        }), {
          availableChildRoleIds: ["worker"], availableWorkerCapabilityCatalog,
          planContext: { mode: "declare", maxItems: 8 },
        })
      : parseSupervisorDecisionOutput(JSON.stringify({ decision }), {
          allowedRoleIds: ["worker"], availableWorkerCapabilityCatalog,
        });
    if (!parsed.ok || parsed.decision.action !== "invoke_role" ||
        parsed.decision.roleId !== "worker") {
      throw new Error("expected_normalized_worker_decision");
    }
    const opened = await ledger.apply({
      expectedHead: ledger.current(),
      command: {
        authority: "active_role", type: "open_child",
        callerCallId: ledger.current().state.activeCallId!,
        roleId: parsed.decision.roleId,
        objective: parsed.decision.objective,
        workerCapabilityScope: parsed.decision.workerCapabilityScope,
        ...("plannerPlan" in parsed.decision
          ? { plannerPlan: parsed.decision.plannerPlan } : {}),
      },
    });
    expect(opened.ok).toBe(true);
    const parked = await resolveRoleCallTransactions(ledger).beginCapabilityExecution({
      expectedHead: ledger.current(),
      callId: ledger.current().state.activeCallId!,
      invocationAttempt: 1,
      capabilityId: "example.write",
      declaredEffect: "mutation",
      intent: "Create the requested artifact.",
      controlsJson: "{}",
      actionFingerprint: `sha256:${"a".repeat(64)}`,
    });
    expect(parked.ok).toBe(true);
    const checkpoint = JSON.parse(JSON.stringify(captureRoleCallLedgerCheckpoint(ledger)));
    const restored = restoreRoleCallLedgerCheckpoint(checkpoint, { requestId, policy });
    expect(restored.current().state.calls.at(-1)?.workerCapabilityScope).toEqual({
      catalogGroupIds: ["write", "read"],
    });
  },
);
