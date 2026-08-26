import type {
  RequestPlanClientEvent,
  RequestPlanCommitProjection,
  RequestPlanEventItem,
  RequestPlanEventPresentation,
} from "./plan-event-projection.js";

export const REQUEST_PLAN_EVENT_STAGE = "development_plan" as const;

/** Preserves the existing client Planner event contract. */
export function createRequestPlanEventPresentation(
  params: Readonly<{
    emissionFailureMessage: string;
  }>,
): RequestPlanEventPresentation<RequestPlanClientEvent> {
  return Object.freeze({
    emissionFailureMessage: params.emissionFailureMessage,
    project(
      projection: RequestPlanCommitProjection,
    ): readonly RequestPlanClientEvent[] {
      const events: RequestPlanClientEvent[] = [
        freezeEvent(`planner.plan.${projection.phase}`, {
          stage: REQUEST_PLAN_EVENT_STAGE,
          phase: projection.phase,
          plan: projection.plan,
        }),
      ];
      for (const change of projection.itemChanges) {
        const name = itemEventName(change.item.status, change.previousStatus);
        if (!name) continue;
        events.push(
          freezeEvent(name, {
            stage: REQUEST_PLAN_EVENT_STAGE,
            phase: projection.phase,
            item: change.item,
            planItemOrder: change.item.order,
            planItemTotal: change.item.total,
            planSummary: projection.plan.summary,
            planTotal: projection.plan.total,
            planCompleted: projection.plan.completed,
          }),
        );
      }
      return Object.freeze(events);
    },
  });
}

function itemEventName(
  current: RequestPlanEventItem["status"],
  previous: RequestPlanEventItem["status"] | undefined,
): string | undefined {
  if (current === "done") return "planner.plan.item.completed";
  if (current === "blocked") return "planner.plan.item.blocked";
  if (current === "in_progress") return "planner.plan.item.started";
  return previous === undefined ? "planner.plan.item.planned" : undefined;
}

function freezeEvent(
  name: string,
  payload: Record<string, unknown>,
): RequestPlanClientEvent {
  return Object.freeze({ name, payload: Object.freeze(payload) });
}
