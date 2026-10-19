import { consumeUnexpectedThenable } from "../orchestration/synchronous-boundary.js";
import {
  isRoleCallResultText,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerCommit,
  type RoleCallResult,
} from "../orchestration/role-calls/index.js";

type ChildReturnedCommit = RoleCallLedgerCommit &
  Readonly<{
    effect: Extract<RoleCallLedgerCommit["effect"], { type: "child_returned" }>;
  }>;

type ReturnedPlanner = RoleCallFrame &
  Readonly<{ roleId: "planner"; resultRef: string }>;

export type RequestRoleReturnEvent = Readonly<{
  name: "role.returned";
  payload: Readonly<{
    callerCallId: string;
    callerRole: "supervisor";
    childCallId: string;
    childRole: "planner";
    outcome: "completed" | "failed";
    summary: string;
  }>;
}>;

/** Projects the stored Planner result without changing role state or active stage. */
export function projectRequestRoleReturnCommit(
  commit: RoleCallLedgerCommit,
): RequestRoleReturnEvent | undefined {
  if (!isDirectSupervisorChildReturn(commit)) return undefined;
  const child = commit.head.state.calls.find(
    (call) => call.callId === commit.effect.childCallId,
  );
  if (!isReturnedPlanner(child, commit.effect)) return undefined;
  const result = commit.head.state.results.find(
    (candidate) => candidate.resultRef === child.resultRef,
  );
  if (!isMatchingPlannerResult(result, child)) return undefined;
  return Object.freeze({
    name: "role.returned",
    payload: Object.freeze({
      callerCallId: commit.effect.callerCallId,
      callerRole: "supervisor",
      childCallId: child.callId,
      childRole: "planner",
      outcome: result.outcome,
      summary: result.summary,
    }),
  });
}

/** Uses the existing synchronous commit boundary, including emission faults. */
export function attachRequestRoleReturnEvents(params: Readonly<{
  ledger: RoleCallLedger;
  onEvent(name: string, payload: Record<string, unknown>): void;
}>): void {
  params.ledger.commits.subscribe((commit) => {
    const event = projectRequestRoleReturnCommit(commit);
    if (!event) return;
    const emitted = Reflect.apply(params.onEvent, undefined, [
      event.name,
      event.payload,
    ]);
    if (consumeUnexpectedThenable(emitted))
      throw new TypeError("Request return event sink must be synchronous.");
  });
}

function isDirectSupervisorChildReturn(
  commit: RoleCallLedgerCommit,
): commit is ChildReturnedCommit {
  if (commit.effect.type !== "child_returned") return false;
  if (commit.head.policy.authority.rootContractId !== "supervisor") return false;
  return commit.effect.callerCallId === commit.head.state.rootCallId;
}

function isReturnedPlanner(
  child: RoleCallFrame | undefined,
  effect: ChildReturnedCommit["effect"],
): child is ReturnedPlanner {
  if (!child) return false;
  if (child.parentCallId !== effect.callerCallId || child.depth !== 1)
    return false;
  if (child.roleId !== "planner" || child.status !== "completed") return false;
  return child.resultRef === effect.resultRef;
}

function isMatchingPlannerResult(
  result: RoleCallResult | undefined,
  child: ReturnedPlanner,
): result is RoleCallResult {
  if (!result) return false;
  if (result.producerCallId !== child.callId || result.roleId !== child.roleId)
    return false;
  if (result.outcome !== "completed" && result.outcome !== "failed")
    return false;
  return isRoleCallResultText(result.summary);
}
