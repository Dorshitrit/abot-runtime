import { consumeUnexpectedThenable } from "../orchestration/synchronous-boundary.js";
import type {
  RoleCallFrame,
  RoleCallLedger,
  RoleCallLedgerCommit,
} from "../orchestration/role-calls/index.js";
import {
  isRuntimeDelegateRoleId,
  type RuntimeDelegateRoleId,
} from "../orchestration/roles.js";

type ChildOpenedCommit = RoleCallLedgerCommit &
  Readonly<{
    effect: Extract<RoleCallLedgerCommit["effect"], { type: "child_opened" }>;
  }>;

type DelegatedChild = RoleCallFrame &
  Readonly<{ roleId: RuntimeDelegateRoleId; objective: string }>;

export type RequestRoleDelegationEvent = Readonly<{
  name: "role.delegated";
  payload: Readonly<{
    callerCallId: string;
    callerRole: "supervisor";
    childCallId: string;
    childRole: RuntimeDelegateRoleId;
    objective: string;
  }>;
}>;

/** Projects the accepted assignment without changing role state or active stage. */
export function projectRequestRoleDelegationCommit(
  commit: RoleCallLedgerCommit,
): RequestRoleDelegationEvent | undefined {
  if (!isDirectSupervisorChildOpen(commit)) return undefined;
  const child = commit.head.state.calls.find(
    (call) => call.callId === commit.effect.childCallId,
  );
  if (!isDirectSupervisorChild(child, commit.effect.callerCallId))
    return undefined;
  return Object.freeze({
    name: "role.delegated",
    payload: Object.freeze({
      callerCallId: commit.effect.callerCallId,
      callerRole: "supervisor",
      childCallId: child.callId,
      childRole: child.roleId,
      objective: child.objective,
    }),
  });
}

/** Uses the existing synchronous commit boundary, including emission faults. */
export function attachRequestRoleDelegationEvents(params: Readonly<{
  ledger: RoleCallLedger;
  onEvent(name: string, payload: Record<string, unknown>): void;
}>): void {
  params.ledger.commits.subscribe((commit) => {
    const event = projectRequestRoleDelegationCommit(commit);
    if (!event) return;
    const emitted = Reflect.apply(params.onEvent, undefined, [
      event.name,
      event.payload,
    ]);
    if (consumeUnexpectedThenable(emitted))
      throw new TypeError("Request delegation event sink must be synchronous.");
  });
}

function isDirectSupervisorChildOpen(
  commit: RoleCallLedgerCommit,
): commit is ChildOpenedCommit {
  if (commit.effect.type !== "child_opened") return false;
  if (commit.head.policy.authority.rootContractId !== "supervisor") return false;
  return commit.effect.callerCallId === commit.head.state.rootCallId;
}

function isDirectSupervisorChild(
  child: RoleCallFrame | undefined,
  callerCallId: string,
): child is DelegatedChild {
  if (!child) return false;
  if (child.parentCallId !== callerCallId) return false;
  if (child.depth !== 1) return false;
  if (!isRuntimeDelegateRoleId(child.roleId)) return false;
  return typeof child.objective === "string";
}
