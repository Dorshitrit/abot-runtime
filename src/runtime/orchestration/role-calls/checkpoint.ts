import type { RoleCallLedger, RoleCallPolicyInput } from "./contracts.js";
import { createRoleCallLedger, isCurrentRoleCallLedgerHead } from "./ledger.js";
import type { RoleCallLedgerCheckpoint } from "./checkpoint-contract.js";
export type { RoleCallLedgerCheckpoint } from "./checkpoint-contract.js";

export function captureRoleCallLedgerCheckpoint(
  ledger: RoleCallLedger,
): RoleCallLedgerCheckpoint {
  const head = ledger.current();
  if (!isCurrentRoleCallLedgerHead(ledger, head))
    throw new Error("role_call_checkpoint_ledger_unowned");
  return Object.freeze({
    kind: "role_call_checkpoint_v1",
    revision: head.revision,
    state: head.state,
    policy: head.policy,
  });
}

export function restoreRoleCallLedgerCheckpoint(
  checkpoint: RoleCallLedgerCheckpoint,
  expected: Readonly<{ requestId: string; policy: RoleCallPolicyInput }>,
): RoleCallLedger {
  return createRoleCallLedger({ ...expected, checkpoint });
}
