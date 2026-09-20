import type {
  RoleCallLedgerCommit,
  RoleCallState,
} from "../orchestration/role-calls/index.js";
import {
  projectRequestPlanCommit,
  type RequestPlanClientEvent,
  type RequestPlanEventPresentation,
  type RequestPlanProjectionState,
} from "./plan-event-projection.js";

export function projectRootWorkPlanCommit(
  commit: RoleCallLedgerCommit,
  presentation: RequestPlanEventPresentation<RequestPlanClientEvent>,
): readonly RequestPlanClientEvent[] {
  if (commit.effect.type !== "model_work_plan_updated") return [];
  return projectRequestPlanCommit({
    previousState: projectRootPlanState(commit.previousHead.state),
    state: projectRootPlanState(commit.head.state),
    presentation,
  });
}

function projectRootPlanState(
  state: RoleCallState,
): RequestPlanProjectionState {
  const plan = state.calls.find(
    (call) => call.callId === state.rootCallId,
  )?.adoptedWorkPlan;
  if (!plan) return {};
  // Namespace only presentation IDs; canonical graph node identifiers retain their exact bounds.
  const itemId = (localId: string) => `${plan.sourceResultRef}:${localId}`;
  return {
    plan: {
      definition: {
        summary: plan.definition.summary,
        items: plan.definition.items.map((item) => ({
          itemId: itemId(item.itemId),
          title: item.title,
        })),
      },
      itemStates: plan.itemStates.map((item) => ({
        itemId: itemId(item.itemId),
        status: item.status,
      })),
    },
  };
}
