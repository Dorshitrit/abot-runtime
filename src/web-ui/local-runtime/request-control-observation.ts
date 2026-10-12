import {
  diagnosticErrorType,
  traceRequestControl,
  type RequestControlDiagnosticFields,
} from "../../runtime/observability/request-control-diagnostics.js";
import type { ActiveRequest, JsonObject } from "./contracts.js";
import { getString } from "./http.js";

export function traceWebRequestControl(
  event: string,
  fields: RequestControlDiagnosticFields,
): void {
  traceRequestControl("web.request_control", event, fields);
}

function projectionFields(
  active: ActiveRequest | undefined,
): RequestControlDiagnosticFields {
  return {
    projectionPresent: active !== undefined,
    environmentId: active?.environmentId,
    sessionId: active?.sessionId,
    projectionStartedAt: active?.startedAt,
    lastEventAt: active?.lastEventAt,
    finalStateStatus: getString(active?.finalState?.status) || undefined,
  };
}

export function traceWebProjection(
  event: "projection.opened" | "projection.removed",
  requestId: string,
  active: ActiveRequest | undefined,
  reason: string,
  removed?: boolean,
): void {
  traceWebRequestControl(event, {
    requestId,
    ...projectionFields(active),
    reason,
    removed,
  });
}

export function webSteerRoute(
  active: ActiveRequest | undefined,
  steer: unknown,
): string {
  if (steer) return "runtime_owner";
  if (!active) return "web_projection_missing";
  return "local_inbox";
}

/** Observes the existing routing decision; it never queries or changes an owner. */
export class WebSteerObservation {
  private readonly startedAt = Date.now();
  private route = "not_routed";

  constructor(
    private readonly requestId: string,
    private readonly steerId: string,
    requestedEnvironment: string,
    textLength: number,
    private readonly active: ActiveRequest | undefined,
    private readonly currentProjection: () => ActiveRequest | undefined,
  ) {
    traceWebRequestControl("steer.received", {
      requestId,
      steerId,
      requestedEnvironment,
      textLength,
      ...projectionFields(active),
    });
  }

  selectRoute(route: string): void {
    this.route = route;
  }

  result(acknowledgement: JsonObject): void {
    this.trace("steer.result", {
      accepted: acknowledgement.accepted === true,
      reason: getString(acknowledgement.reason) || undefined,
      acceptedSequence:
        typeof acknowledgement.acceptedSequence === "number"
          ? acknowledgement.acceptedSequence
          : undefined,
    });
  }

  failed(error: unknown): void {
    this.trace("steer.failed", { errorType: diagnosticErrorType(error) });
  }

  private trace(event: string, fields: RequestControlDiagnosticFields): void {
    const current = this.currentProjection();
    traceWebRequestControl(event, {
      requestId: this.requestId,
      steerId: this.steerId,
      route: this.route,
      ...projectionFields(this.active),
      currentProjectionPresent: current !== undefined,
      projectionStillCurrent:
        this.active !== undefined && current === this.active,
      elapsedMs: Date.now() - this.startedAt,
      ...fields,
    });
  }
}
