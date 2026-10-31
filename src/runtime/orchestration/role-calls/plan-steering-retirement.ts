import type {
  RoleCallFrame,
  RoleCallPlanItemState,
  RoleCallPlanState,
  RoleCallResult,
  RoleCallState,
} from "./contracts.js";
import type { RoleCallPlanSettlementResult } from "./plan-binding.js";
import { isWorkerSteeringVersion } from "./worker-steering.js";

/** Retire only the unfinished remainder; historical assignments and effects stay intact. */
export function retireRoleCallPlanForSteering(params: {
  state: RoleCallState;
  caller: RoleCallFrame;
  childCallId: string;
  steeringVersion: number;
}): RoleCallPlanSettlementResult {
  const existing = params.state.plans.find(
    (plan) => plan.definition.plannerCallId === params.caller.callId,
  );
  if (!existing) return { ok: true, plans: params.state.plans };
  const assigned = existing.itemStates.filter(
    (item) => item.childCallId === params.childCallId,
  );
  if (assigned.length === 0)
    return { ok: false, code: "planner_plan_binding_invalid" };
  if (assigned.some((item) => item.status !== "in_progress"))
    return { ok: false, code: "planner_plan_binding_invalid" };
  const replacement = Object.freeze({
    ...existing,
    itemStates: Object.freeze(
      existing.itemStates.map((item) => {
        if (!isUnfinishedRolePlanItem(item)) return item;
        return Object.freeze({
          ...item,
          status: "retired" as const,
          retiredBySteeringVersion: params.steeringVersion,
        });
      }),
    ),
  });
  return Object.freeze({
    ok: true,
    plans: Object.freeze(
      params.state.plans.map((plan) =>
        plan === existing ? replacement : plan,
      ),
    ),
    planItemIds: Object.freeze(assigned.map((item) => item.itemId)),
  });
}

export function latestRolePlanSteeringVersion(
  plan: RoleCallPlanState,
): number | undefined {
  const versions = plan.itemStates.flatMap((item) =>
    item.retiredBySteeringVersion === undefined
      ? []
      : [item.retiredBySteeringVersion],
  );
  return versions.length === 0 ? undefined : Math.max(...versions);
}

export function isUnfinishedRolePlanItem(
  item: Pick<RoleCallPlanItemState, "status">,
): boolean {
  if (item.status === "pending") return true;
  return item.status === "in_progress";
}

export function hasValidPlanSteeringRetirement(
  state: RoleCallState,
  planner: RoleCallFrame,
  item: RoleCallPlanItemState,
): boolean {
  if (item.status !== "retired")
    return item.retiredBySteeringVersion === undefined;
  if (!isWorkerSteeringVersion(item.retiredBySteeringVersion)) return false;
  return state.results.some((result) => {
    if (result.outcome !== "yielded") return false;
    if (result.steeringVersion !== item.retiredBySteeringVersion) return false;
    const producer = state.calls.find(
      (call) => call.callId === result.producerCallId,
    );
    if (producer?.parentCallId !== planner.callId) return false;
    if (item.childCallId === null) return true;
    return item.childCallId === producer.callId;
  });
}

export function isUnboundRetiredPlanItem(item: RoleCallPlanItemState): boolean {
  if (item.status !== "retired") return false;
  return item.childCallId === null;
}

export function isValidRetiredPlanChild(
  child: RoleCallFrame,
  result: RoleCallResult | undefined,
): boolean {
  if (child.status !== "completed") return false;
  if (result?.producerCallId !== child.callId) return false;
  return result.outcome === "yielded";
}
