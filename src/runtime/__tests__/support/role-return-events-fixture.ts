import { vi } from "vitest";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type ExecutionPolicyAuthoritySnapshot,
  type RoleCallLedger,
  type RoleCallLedgerCommand,
} from "../../orchestration/role-calls/index.js";
import type { RuntimeDelegateRoleId } from "../../orchestration/roles.js";
import { attachRequestRoleReturnEvents } from "../../request/role-call-return-events.js";

export const requestId = "planner-return-events";

export async function createObservedReturnLedger(
  authority: ExecutionPolicyAuthoritySnapshot =
    SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
) {
  const ledger = createRoleCallLedger({
    requestId,
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
  const onEvent = vi.fn<
    (name: string, payload: Record<string, unknown>) => void
  >();
  attachRequestRoleReturnEvents({ ledger, onEvent });
  await commit(ledger, { authority: "runtime", type: "create_root" });
  return { ledger, onEvent };
}

export async function commit(
  ledger: RoleCallLedger,
  command: RoleCallLedgerCommand,
) {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(`test_return_commit_failed:${result.code}`);
  return result;
}

export function openChild(
  ledger: RoleCallLedger,
  roleId: RuntimeDelegateRoleId = "planner",
  callerCallId = "call-1",
) {
  return commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId,
    roleId,
    objective: "Report the delegated outcome.",
  });
}

export function returnChild(
  ledger: RoleCallLedger,
  options: Readonly<{
    callerCallId?: string;
    childCallId?: string;
    outcome?: "completed" | "failed";
    summary?: string;
  }> = {},
) {
  return commit(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: options.callerCallId ?? "call-1",
    childCallId: options.childCallId ?? "call-2",
    outcome: options.outcome ?? "completed",
    summary: options.summary ?? "The delegated outcome is complete.",
  });
}
