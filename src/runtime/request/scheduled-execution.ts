import type { ScheduleMessageReference } from "../../sessions/schedule-metadata.js";
import type { RuntimeRequestOptions } from "../composition.js";
import type { SchedulerRun } from "../scheduler/contracts.js";
import type { RequestHandlerOptions } from "./contracts.js";

// Only scheduler-owned execution can mint this option. It survives host option
// spreads but cannot be supplied by a decoded public request or RPC payload.
const scheduledExecution = Symbol("scheduledExecution");
type ScheduledExecution = Readonly<{
  requestId: string;
  sessionId: string;
  reference: ScheduleMessageReference;
}>;
type ScheduledRequestOptions = RuntimeRequestOptions & {
  [scheduledExecution]?: ScheduledExecution;
};

export function withScheduledExecution(
  options: RuntimeRequestOptions | undefined,
  run: SchedulerRun,
): RuntimeRequestOptions {
  const captured: ScheduledExecution = Object.freeze({
    requestId: run.requestId,
    sessionId: run.sessionId,
    reference: Object.freeze({
      jobId: run.jobId,
      runId: run.id,
      title: run.title,
      scheduledAt: run.scheduledAt,
      triggerType: run.trigger,
    }),
  });
  const bound: ScheduledRequestOptions = {
    ...options,
    [scheduledExecution]: captured,
  };
  return bound;
}

export function resolveScheduledExecution(
  options: RequestHandlerOptions,
  identity: { requestId: string; sessionId: string },
): ScheduleMessageReference | undefined {
  const captured = (options as ScheduledRequestOptions)[scheduledExecution];
  if (!captured) return undefined;
  const matchesRequest = captured.requestId === identity.requestId;
  const matchesSession = captured.sessionId === identity.sessionId;
  if (!matchesRequest || !matchesSession) {
    throw new Error("scheduled_request_identity_mismatch");
  }
  return captured.reference;
}
