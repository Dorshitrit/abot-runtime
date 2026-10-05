import { normalizeRealtimeMessage } from "./realtime-message.js";

const replayBinding = Symbol("context replay binding");

export function captureContextReplayScope(state, environmentId, requestId) {
  return {
    environmentId,
    sessionId: state.currentSessionId,
    viewVersion: state.sessionViewVersion,
    requestId,
    generation: state.requestLifecycles?.get(requestId)?.generation || "",
  };
}

export function isContextReplayCurrent(scope, state, environmentId) {
  if (scope.environmentId !== environmentId) return false;
  if (scope.sessionId !== state.currentSessionId) return false;
  if (scope.viewVersion !== state.sessionViewVersion) return false;
  const generation =
    state.requestLifecycles?.get(scope.requestId)?.generation || "";
  return scope.generation === generation;
}

export function bindContextReplayEvents(events, scope) {
  const replayDomain = {};
  return events
    .map(normalizeRealtimeMessage)
    .filter((event) => event.requestId === scope.requestId)
    .sort((left, right) => (left.seqNo || 0) - (right.seqNo || 0))
    .map((event, index) => ({
      ...event,
      [replayBinding]: { ...scope, replayDomain, replayOrder: index + 1 },
    }));
}

export function contextReplayBinding(event) {
  return event[replayBinding] || null;
}
