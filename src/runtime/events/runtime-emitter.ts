import type WebSocket from "ws";

import { traceDebug } from "../observability/debug-logger.js";
import { enrichEventPayload } from "./event-status.js";
import type { RequestLifecycleState } from "../orchestration/lifecycle/request-lifecycle.js";

export type RuntimeEventPersist = (
  payload: Record<string, unknown>,
) => Promise<unknown>;

type RuntimeEventBusOptions = {
  requestId: string;
  ws: WebSocket;
  persist?: RuntimeEventPersist;
};

function isReplayableRequestPayload(payload: Record<string, unknown>): boolean {
  const type = typeof payload.type === "string" ? payload.type : "";
  const name = typeof payload.name === "string" ? payload.name : "";
  if (type === "event" && name === "token") {
    return false;
  }
  return (
    type === "event" ||
    type === "token" ||
    type === "completed" ||
    type === "failed"
  );
}

function payloadRequestId(payload: Record<string, unknown>): string {
  return typeof payload.requestId === "string" ? payload.requestId : "";
}

function boundedControlValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : undefined;
}

function logOutboundEventPayload(
  rawPayload: Record<string, unknown>,
  enrichedPayload: Record<string, unknown>,
): void {
  const type = typeof rawPayload.type === "string" ? rawPayload.type : "";
  if (type !== "event") {
    return;
  }

  const rawName = typeof rawPayload.name === "string" ? rawPayload.name : "";
  if (rawName === "thinking.delta" || rawName === "token") {
    return;
  }

  const emittedName =
    typeof enrichedPayload.name === "string" ? enrichedPayload.name : "";

  // Streaming deltas are delivered to the UI, but are intentionally not traced
  // one-by-one. Model gateway completion and finalized thinking events already
  // provide bounded stream-level diagnostics. Event content remains available
  // to the client and persistence path; the trace records only control-plane
  // metadata so user and role content cannot leak through display enrichment.
  traceDebug("runtime.emitter", "ui.event.emit", {
    requestId: payloadRequestId(rawPayload) || undefined,
    rawName: boundedControlValue(rawName),
    rawNameLength: rawName.length,
    emittedNameChanged: emittedName !== rawName,
    emittedNameLength: emittedName.length,
    eventSequence:
      typeof enrichedPayload.eventSequence === "number"
        ? enrichedPayload.eventSequence
        : undefined,
    stage: boundedControlValue(enrichedPayload.stage),
    phase: boundedControlValue(enrichedPayload.phase),
    payloadFieldCount: Object.keys(enrichedPayload).length,
  });
}

function isInternalLifecycleEvent(name: string): boolean {
  return name === "thinking.started" || name === "thinking.completed";
}

export class RuntimeEventBus {
  private persistQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private eventSequence = 0;

  constructor(private readonly options: RuntimeEventBusOptions) {}

  publish(payload: Record<string, unknown>): void {
    const outboundPayload = this.withEventSequence(this.withRequestId(payload));
    const enrichedPayload = enrichEventPayload(outboundPayload);
    this.persistIfNeeded(enrichedPayload);
    logOutboundEventPayload(outboundPayload, enrichedPayload);
    this.options.ws.send(JSON.stringify(enrichedPayload));
  }

  event(name: string, extra: Record<string, unknown> = {}): void {
    if (isInternalLifecycleEvent(name)) {
      traceDebug("runtime.emitter", "internal.event", {
        requestId: this.options.requestId || undefined,
        name,
        payload: extra,
      });
      return;
    }
    this.publish({
      type: "event",
      requestId: this.options.requestId,
      name,
      ...extra,
    });
  }

  runtimeState(state: RequestLifecycleState): void {
    const details = formatRuntimeStateDetails(state);
    traceDebug("runtime.emitter", "runtime.state", {
      requestId: this.options.requestId || undefined,
      state,
      details: details || undefined,
    });
  }

  token(token: string): void {
    this.event("token", { text: token });
  }

  legacyToken(text: string): void {
    this.publish({ type: "token", requestId: this.options.requestId, text });
  }

  thinkingDelta(delta: string, accumulatedText: string): void {
    this.event("thinking.delta", {
      delta,
      text: accumulatedText,
    });
  }

  completed(output: string): void {
    this.publish({
      type: "completed",
      requestId: this.options.requestId,
      output,
    });
  }

  failed(error: string, details?: Record<string, unknown>): void {
    this.publish({
      type: "failed",
      requestId: this.options.requestId,
      error,
      ...(details ? { details } : {}),
    });
  }

  async drain(): Promise<void> {
    await this.persistQueue;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
  }

  private withRequestId(
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    if (payloadRequestId(payload) || !this.options.requestId) {
      return payload;
    }
    return { ...payload, requestId: this.options.requestId };
  }

  private withEventSequence(
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    this.eventSequence += 1;
    return { ...payload, eventSequence: this.eventSequence };
  }

  private persistIfNeeded(payload: Record<string, unknown>): void {
    if (!this.options.persist || !isReplayableRequestPayload(payload)) {
      return;
    }
    this.persistQueue = this.persistQueue
      .then(async () => {
        await this.options.persist?.(payload);
      })
      .catch((error: unknown) => {
        traceDebug("runtime.emitter", "request_event_persist_failed", {
          requestId: this.options.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}

export function createRuntimeEventBus(
  options: RuntimeEventBusOptions,
): RuntimeEventBus {
  return new RuntimeEventBus(options);
}

function friendlyRuntimeReason(reason: string): string {
  switch (reason) {
    case "selection":
      return "previous choice was not usable";
    case "no_progress":
      return "no new progress was detected";
    case "invalid_final_output":
      return "the final response was not usable yet";
    default:
      return reason.replace(/_/g, " ");
  }
}

function formatRuntimeStateDetails(state: RequestLifecycleState): string {
  return [
    state.reason ? friendlyRuntimeReason(state.reason) : "",
    typeof state.attempt === "number"
      ? `recovery attempt ${state.attempt}`
      : "",
    typeof state.toolIteration === "number"
      ? `tool step ${state.toolIteration}`
      : "",
    typeof state.decisionAttemptCount === "number"
      ? `decision attempt ${state.decisionAttemptCount}`
      : "",
  ]
    .filter((part) => part.length > 0)
    .join(", ");
}
