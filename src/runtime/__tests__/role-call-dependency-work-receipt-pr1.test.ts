import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createRoleCallLedger,
  projectRoleCallDependencyResults,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function createLedger(): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "dependency-work-receipt-pr1",
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
): Promise<RoleCallLedgerHead> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(`role_call_commit_rejected:${result.code}`);
  return result.head;
}

describe("PR1 dependency work-receipt projection", () => {
  test("preserves the exact canonical work receipt for a dependent role", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Produce one bounded result.",
    });
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-2",
      outcome: "completed",
      summary: "The bounded result was produced.",
    });
    const plannerHead = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Coordinate work that depends on the result.",
      dependencyResultRefs: ["result-1"],
    });
    const sourceResult = plannerHead.state.results[0];
    if (!sourceResult) throw new Error("source_result_missing");
    const receipt = sourceResult.receipt;
    if (receipt?.kind !== "work_result_v1") {
      throw new Error("work_result_receipt_missing");
    }
    const plannerCall = plannerHead.state.calls.find(
      ({ callId }) => callId === "call-3",
    );
    if (!plannerCall) throw new Error("planner_call_missing");

    const projected = projectRoleCallDependencyResults(
      plannerHead,
      plannerCall,
    );

    expect(projected).toEqual([
      {
        resultRef: "result-1",
        producerCallId: "call-2",
        roleId: "worker",
        outcome: "completed",
        summary: "The bounded result was produced.",
        receipt,
      },
    ]);
    expect(projected[0]?.receipt).toBe(receipt);
    expect(projected[0]).not.toHaveProperty("workLineage");
  });
});
