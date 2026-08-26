import { traceDebug } from "../observability/debug-logger.js";
import { classifyRuntimeErrorType } from "../observability/error-type.js";
import type { RoleCallLedgerCommit } from "../orchestration/role-calls/index.js";
import type { RequestPlanClientEvent } from "./plan-event-projection.js";

const REQUEST_PLANNER_EVENT_LOG_SCOPE = "runtime.request_planner_events";

export type RequestPlannerEventFailureStage = "project" | "emit";

export function traceRequestPlannerEventsProjected(params: {
  commit: RoleCallLedgerCommit;
  events: readonly RequestPlanClientEvent[];
}): void {
  traceDebug(REQUEST_PLANNER_EVENT_LOG_SCOPE, "projection.completed", {
    ...projectCommit(params.commit),
    ...projectEventBatch(params.events),
  });
}

export function traceRequestPlannerEventsEmitted(params: {
  commit: RoleCallLedgerCommit;
  events: readonly RequestPlanClientEvent[];
}): void {
  traceDebug(REQUEST_PLANNER_EVENT_LOG_SCOPE, "emission.completed", {
    ...projectCommit(params.commit),
    ...projectEventBatch(params.events),
  });
}

export function traceRequestPlannerEventsFailed(params: {
  commit: RoleCallLedgerCommit;
  failureStage: RequestPlannerEventFailureStage;
  error: unknown;
  eventName?: string;
}): void {
  traceDebug(REQUEST_PLANNER_EVENT_LOG_SCOPE, "emission.failed", {
    ...projectCommit(params.commit),
    failureStage: params.failureStage,
    ...(params.eventName ? { eventName: params.eventName } : {}),
    errorType: classifyRuntimeErrorType(params.error),
  });
}

function projectCommit(commit: RoleCallLedgerCommit): Record<string, unknown> {
  return {
    requestId: commit.head.state.requestId,
    previousRevision: commit.previousHead.revision,
    revision: commit.head.revision,
    effectType: commit.effect.type,
    ...(commit.effect.type === "child_opened" ||
    commit.effect.type === "child_returned"
      ? {
          plannerCallId: commit.effect.callerCallId,
          childCallId: commit.effect.childCallId,
        }
      : {}),
  };
}

function projectEventBatch(
  events: readonly RequestPlanClientEvent[],
): Record<string, unknown> {
  const snapshot = readPlanSnapshot(events[0]?.payload);
  return {
    eventCount: events.length,
    eventNames: events.map((event) => event.name),
    ...(typeof events[0]?.payload.phase === "string"
      ? { phase: events[0].payload.phase }
      : {}),
    ...(snapshot
      ? {
          planTotal: snapshot.total,
          planCompleted: snapshot.completed,
          planBlocked: snapshot.blocked,
          planPending: snapshot.pending,
          planInProgress: snapshot.inProgress,
        }
      : {}),
  };
}

function readPlanSnapshot(
  payload: Readonly<Record<string, unknown>> | undefined,
):
  | Readonly<{
      total: number;
      completed: number;
      blocked: number;
      pending: number;
      inProgress: number;
    }>
  | undefined {
  const plan = payload?.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return undefined;
  }
  const candidate = plan as Record<string, unknown>;
  if (
    typeof candidate.total !== "number" ||
    typeof candidate.completed !== "number" ||
    typeof candidate.blocked !== "number" ||
    typeof candidate.pending !== "number" ||
    typeof candidate.inProgress !== "number"
  ) {
    return undefined;
  }
  return Object.freeze({
    total: candidate.total,
    completed: candidate.completed,
    blocked: candidate.blocked,
    pending: candidate.pending,
    inProgress: candidate.inProgress,
  });
}
