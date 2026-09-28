import type {
  SessionMessage,
  SessionRecord,
  SessionRequestRecord,
} from "../types.js";
import {
  compactRequestEvents,
  toClientReplayEvent,
  toSnapshotMessage,
} from "../record/projection.js";
import { projectSessionRequestLifecycle } from "./projection.js";
import type {
  SessionActivationExpectation,
  SessionLifecycleMutationResult,
  SessionLifecycleRejectionReason,
  SessionRequestLifecycleRecord,
  SessionWaitExpectation,
} from "./contracts.js";

export type LifecycleMutationContext = Readonly<{
  session: SessionRecord;
  timestamp: string;
  createMessageId(session: SessionRecord): string;
}>;
export type LifecycleRequest = SessionRequestRecord & {
  generation: string;
  lifecycle: SessionRequestLifecycleRecord;
};

export function rejectLifecycleCommand(
  reason: SessionLifecycleRejectionReason,
  request?: SessionRequestRecord,
): SessionLifecycleMutationResult {
  const current = request ? projectSessionRequestLifecycle(request) : undefined;
  return { accepted: false, reason, ...(current ? { current } : {}) };
}

export function lifecycleRequest(
  session: SessionRecord,
  requestId: string,
): LifecycleRequest | undefined {
  const request = session.requests?.find(
    (entry) => entry.requestId === requestId,
  );
  if (!request?.generation || request.lifecycle?.schemaVersion !== 1)
    return undefined;
  return request as LifecycleRequest;
}

export function hasNonemptyIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateRequestExpectation(
  request: LifecycleRequest | undefined,
  expected: Readonly<{ generation: string; revision: number }>,
): SessionLifecycleRejectionReason | undefined {
  if (!request) return "lifecycle_missing";
  if (request.generation !== expected.generation) return "generation_mismatch";
  if (request.lifecycle.revision !== expected.revision)
    return "revision_mismatch";
  return undefined;
}

export function validateActivationExpectation(
  request: LifecycleRequest | undefined,
  expected: SessionActivationExpectation,
): SessionLifecycleRejectionReason | undefined {
  const mismatch = validateRequestExpectation(request, expected);
  if (mismatch) return mismatch;
  if (request!.status !== "streaming") return "request_not_running";
  if (request!.lifecycle.activation.activationId !== expected.activationId)
    return "activation_mismatch";
  if (request!.lifecycle.activation.ownerEpoch !== expected.ownerEpoch)
    return "activation_mismatch";
  return undefined;
}

export function validateWaitExpectation(
  request: LifecycleRequest | undefined,
  expected: SessionWaitExpectation,
): SessionLifecycleRejectionReason | undefined {
  const mismatch = validateRequestExpectation(request, expected);
  if (mismatch) return mismatch;
  if (request!.status !== "awaiting_approval") return "request_not_waiting";
  if (request!.lifecycle.wait?.waitId !== expected.waitId)
    return "wait_mismatch";
  return undefined;
}

export function touchLifecycle(
  context: LifecycleMutationContext,
  request: LifecycleRequest,
): void {
  request.lifecycle.revision += 1;
  request.updatedAt = context.timestamp;
  context.session.updatedAt = context.timestamp;
}

export function appendLifecycleEvent(
  context: LifecycleMutationContext,
  request: LifecycleRequest,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const seqNo = request.lastSeqNo + 1;
  const type = typeof payload.type === "string" ? payload.type : "event";
  const event = {
    ...structuredClone(payload),
    type,
    sessionId: request.sessionId,
    requestId: request.requestId,
    generation: request.generation,
    activationId: request.lifecycle.activation.activationId,
    seqNo,
    eventSequence: seqNo,
    timestamp: context.timestamp,
  };
  request.lastSeqNo = seqNo;
  const stored = {
    seqNo,
    type,
    requestId: request.requestId,
    timestamp: context.timestamp,
    payload: event,
  };
  request.events.push(stored);
  request.events = compactRequestEvents(request.events);
  return toClientReplayEvent(stored);
}

export function appendLifecycleMessage(
  context: LifecycleMutationContext,
  input: Omit<SessionMessage, "id" | "createdAt">,
): SessionMessage {
  const message = {
    ...structuredClone(input),
    id: context.createMessageId(context.session),
    createdAt: context.timestamp,
  };
  context.session.messages.push(message);
  context.session.messageCount = context.session.messages.length;
  return message;
}

export function acceptedLifecycle(
  request: LifecycleRequest,
  events: readonly Record<string, unknown>[] = [],
): SessionLifecycleMutationResult & { accepted: true } {
  return {
    accepted: true,
    current: projectSessionRequestLifecycle(request)!,
    events,
  };
}

export function appendLifecycleChangedEvent(
  context: LifecycleMutationContext,
  request: LifecycleRequest,
): Record<string, unknown> {
  const message = [...context.session.messages]
    .reverse()
    .find(
      (entry) =>
        entry.role === "assistant" && entry.requestId === request.requestId,
    );
  return appendLifecycleEvent(context, request, {
    type: "event",
    name: "request.lifecycle.changed",
    lifecycle: projectSessionRequestLifecycle(request),
    ...(message
      ? {
          message: toSnapshotMessage(
            context.session.id,
            message,
            context.session.requests ?? [],
          ),
        }
      : {}),
  });
}
