import type WebSocket from "ws";

import type { SessionThinkingTraceEntry } from "../../sessions/types.js";
import type { RuntimeThinkingTrace } from "../model/thinking-trace.js";
import type { EventSink, EventSinkFactory } from "../ports.js";
import type { RequestSessionStore } from "../request/session-store.js";

export function createInitialRequestEvents(params: {
  eventSinkFactory: EventSinkFactory;
  requestId: string;
  ws: WebSocket;
}): EventSink {
  return params.eventSinkFactory.create({
    requestId: params.requestId,
    ws: params.ws,
  });
}

export function createPersistentRequestEvents(params: {
  currentEvents: EventSink;
  eventSinkFactory: EventSinkFactory;
  requestId: string;
  sessionId: string;
  sessionStore: RequestSessionStore;
  ws: WebSocket;
}): EventSink {
  params.currentEvents.dispose();
  return params.eventSinkFactory.create({
    requestId: params.requestId,
    ws: params.ws,
    persist: (payload) =>
      params.sessionStore.appendRequestEvent(
        params.sessionId,
        params.requestId,
        payload,
      ),
  });
}

export type RequestPresentationSnapshot = Readonly<{
  answerText: string;
  thinkingText: string;
  thinkingTrace: readonly RuntimeThinkingTrace[];
}>;

export function createRequestCallbacks(
  events: EventSink,
  restored?: RequestPresentationSnapshot,
): {
  onAcknowledgement: (acknowledgement: string) => void;
  onThinkingDelta: (delta: string) => void;
  onThinkingTrace: (entry: RuntimeThinkingTrace) => void;
  onAnswerToken: (token: string) => void;
  getAnswerText: () => string;
  getThinkingTrace: () => SessionThinkingTraceEntry[] | undefined;
  snapshot: () => RequestPresentationSnapshot;
} {
  let accumulatedAnswer = restored?.answerText ?? "";
  let accumulatedThinking = restored?.thinkingText ?? "";
  const thinkingTrace: RuntimeThinkingTrace[] = structuredClone([
    ...(restored?.thinkingTrace ?? []),
  ]);

  return {
    snapshot: () =>
      structuredClone({
        answerText: accumulatedAnswer,
        thinkingText: accumulatedThinking,
        thinkingTrace,
      }),
    onAcknowledgement: (acknowledgement) => {
      const delta = `${acknowledgement}\n\n`;
      events.thinkingDelta(delta, delta);
    },
    onThinkingDelta: (delta) => {
      accumulatedThinking += delta;
      events.thinkingDelta(delta, accumulatedThinking);
    },
    onThinkingTrace: (entry) => {
      if (entry.text.trim().length > 0) {
        thinkingTrace.push(entry);
      }
    },
    onAnswerToken: (token) => {
      if (!token) {
        return;
      }
      accumulatedAnswer += token;
      events.legacyToken(accumulatedAnswer);
    },
    getAnswerText: () => accumulatedAnswer,
    getThinkingTrace: () => {
      if (thinkingTrace.length === 0) {
        return undefined;
      }
      return thinkingTrace.map((entry, index) => ({
        sequence: index + 1,
        step: entry.step,
        status: entry.status,
        text: entry.text,
      }));
    },
  };
}
