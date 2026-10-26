import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createRoleCallLedger,
  projectRoleCallDependencyResults,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type ExecutionPolicyAuthoritySnapshot,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { bindCapabilityDependencyResults } from "../orchestration/worker-capabilities/binding/dependency-results.js";

const PRODUCER_OBJECTIVE = 'Read evidence/source-01.md and preserve its exact "MID FACT" code.';

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function createLedger(
  authority: ExecutionPolicyAuthoritySnapshot = SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "dependency-work-receipt-pr1",
    policy: {
      authority,
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

async function createDependency(
  consumerRole: "planner" | "worker",
  authority = SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
) {
  const ledger = createLedger(authority);
  await commit(ledger, { authority: "runtime", type: "create_root" });
  await commit(ledger, {
    authority: "active_role", type: "open_child", callerCallId: "call-1",
    roleId: "worker", objective: PRODUCER_OBJECTIVE,
  });
  await commit(ledger, {
    authority: "runtime", type: "return_child", callerCallId: "call-1",
    childCallId: "call-2", outcome: "completed", summary: "The bounded result was produced.",
  });
  const head = await commit(ledger, {
    authority: "active_role", type: "open_child", callerCallId: "call-1",
    roleId: consumerRole, objective: "Read evidence/source-02.md using only relevant prior findings.",
    dependencyResultRefs: ["result-1"],
  });
  return { head, call: head.state.calls.find(({ callId }) => callId === "call-3")! };
}

describe("PR1 dependency work-receipt projection", () => {
  test("preserves the exact canonical work receipt for a dependent role", async () => {
    const { head: plannerHead, call: plannerCall } = await createDependency("planner");
    const sourceResult = plannerHead.state.results[0];
    if (!sourceResult) throw new Error("source_result_missing");
    const receipt = sourceResult.receipt;
    if (receipt?.kind !== "work_result_v1") {
      throw new Error("work_result_receipt_missing");
    }
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

  test.each([true, false])("projects producer scope only for the frozen SUPER Worker contract (%s)", async (superContract) => {
    const authority = superContract ? SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT : Object.freeze({
      ...SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
      definitionHash: `sha256:${"a".repeat(64)}`,
    });
    const { head, call } = await createDependency("worker", authority);
    const projected = projectRoleCallDependencyResults(head, call);
    expect(projected[0]).toMatchObject({
      producerCallId: "call-2", resultRef: "result-1", summary: "The bounded result was produced.",
    });
    if (superContract) expect(projected[0]?.producerObjective).toBe(PRODUCER_OBJECTIVE);
    else expect(projected[0]).not.toHaveProperty("producerObjective");
    expect(bindCapabilityDependencyResults(head, call, projected)).toEqual(projected);
    const forged = Object.freeze([Object.freeze({ ...projected[0]!, producerObjective: call.objective! })]);
    expect(() => bindCapabilityDependencyResults(head, call, forged)).toThrow("worker_dependency_results_invalid");
  });
});
