import { contextTransportSequenceDomain } from "./realtime-message.js";
import {
  canReplaceContextWindowEvidence,
  hasOrderedContextEvidence,
} from "./context-window-snapshot-order.js";
import {
  selectContextInputMeasurement,
  normalizeContextProviderCounts,
} from "./context-window-measurement.js";
import {
  reduceContextCompaction,
  interruptContextCompactions,
  projectContextCompactions,
} from "./context-compaction-state.js";
import { contextReplayBinding } from "./context-window-replay.js";

function identityText(value) {
  return typeof value === "string" ? value : "";
}

function matchesContextView(value, scope) {
  if (!value) return false;
  for (const key of [
    "requestId",
    "environmentId",
    "sessionId",
    "viewVersion",
  ]) {
    if (value[key] !== scope[key]) return false;
  }
  return true;
}

export function contextEvidenceScope(state, environmentId, requestId) {
  const scope = {
    requestId,
    environmentId,
    sessionId: state.currentSessionId,
    viewVersion: state.sessionViewVersion,
    generation: "",
    generationSource: "legacy",
    requestKnown: Boolean(
      state.requestLifecycles?.has(requestId) ||
      state.requestMessages?.has(requestId) ||
      state.activeRequestId === requestId,
    ),
  };
  const lifecycle = state.requestLifecycles?.get(requestId);
  if (lifecycle)
    return {
      ...scope,
      generation: identityText(lifecycle.generation),
      generationSource: "lifecycle",
    };
  const previous = state.contextWindowByRequest?.get(requestId);
  if (!matchesContextView(previous, scope) || !previous.generation)
    return scope;
  return {
    ...scope,
    generation: previous.generation,
    generationSource: previous.generationSource || "event",
  };
}

function hasMatchingReplayScope(replay, scope, event) {
  if (!matchesContextView(replay, scope)) return false;
  if (replay.generation === scope.generation) return true;
  return (
    !replay.generation &&
    Boolean(scope.generation) &&
    identityText(event.generation) === scope.generation
  );
}

function canBindInitialGeneration(event, scope) {
  if (!identityText(scope.environmentId).trim()) return false;
  if (!identityText(scope.sessionId).trim()) return false;
  if (scope.generation || scope.generationSource !== "legacy") return false;
  if (!identityText(event.generation)) return false;
  const replay = contextReplayBinding(event);
  if (hasMatchingReplayScope(replay, scope, event)) return true;
  return (
    event.sessionId === scope.sessionId &&
    (event.environment || event.environmentId) === scope.environmentId &&
    hasOrderedContextEvidence(event)
  );
}

function belongsToContextEvidenceScope(event, scope) {
  if (!scope.requestKnown || !scope.requestId) return false;
  if (event.requestId !== scope.requestId) return false;
  const environmentId = identityText(event.environment || event.environmentId);
  if (environmentId && environmentId !== scope.environmentId) return false;
  const sessionId = identityText(event.sessionId);
  if (sessionId && sessionId !== scope.sessionId) return false;
  const replay = contextReplayBinding(event);
  if (replay && !hasMatchingReplayScope(replay, scope, event)) return false;
  const generation = identityText(event.generation);
  if (generation)
    return (
      generation === scope.generation || canBindInitialGeneration(event, scope)
    );
  if (scope.generation) return hasMatchingReplayScope(replay, scope, event);
  return true;
}

export function contextEvidenceOrder(event, scope) {
  if (!belongsToContextEvidenceScope(event, scope)) return {};
  const replay = contextReplayBinding(event);
  const identity = [
    scope.environmentId,
    scope.sessionId,
    scope.requestId,
    scope.generation,
  ];
  return {
    contextScope: JSON.stringify(identity),
    sequenceDomain: JSON.stringify([
      ...identity,
      contextTransportSequenceDomain(event),
    ]),
    replayDomain: replay?.replayDomain,
    replayOrder: replay?.replayOrder,
  };
}

function bindContextEvidence(event, scope) {
  return {
    ...event,
    requestId: scope.requestId,
    invocationId: identityText(event.invocationId),
    modelStep: identityText(event.modelStep),
    profileId: identityText(event.profileId),
    admissionOutcome: identityText(event.admissionOutcome),
    generation: scope.generation,
    sessionId: scope.sessionId,
    environmentId: scope.environmentId,
    ...contextEvidenceOrder(event, scope),
  };
}

function isRequestTerminalEvidence(event, scope) {
  if (event.type === "completed" || event.type === "failed") return true;
  if (!scope.acceptedLifecycle || event.name !== "request.lifecycle.changed")
    return false;
  return ["completed", "failed"].includes(event.lifecycle?.status);
}

function createContextWindowState(scope) {
  return {
    ...scope,
    latestSnapshotObservation: null,
    lastValidSnapshot: null,
    usageByInvocation: new Map(),
    cycles: new Map(),
    requestTerminal: null,
    snapshot: null,
    providerUsage: null,
    pendingCompaction: null,
    lastCompaction: null,
    lastCompactionEvent: null,
    openCompactionCount: 0,
  };
}

function hasMatchingInvocationBinding(snapshot, usage) {
  if (!snapshot?.invocationId || snapshot.invocationId !== usage?.invocationId)
    return false;
  for (const key of [
    "requestId",
    "generation",
    "modelStep",
    "profileId",
    "provider",
    "model",
    "contextWindowTokens",
    "activationId",
    "modelInvocationScope",
  ]) {
    if (snapshot[key] === undefined || snapshot[key] === "") continue;
    if (usage[key] === undefined || usage[key] === "") continue;
    if (snapshot[key] !== usage[key]) return false;
  }
  return true;
}

function projectContextWindowState(current) {
  const observation = current.latestSnapshotObservation;
  const snapshot =
    observation?.availability === "available"
      ? { ...observation, ...observation.measurement }
      : null;
  const usage = current.usageByInvocation.get(observation?.invocationId);
  const providerUsage = hasMatchingInvocationBinding(observation, usage)
    ? usage
    : null;
  return {
    ...current,
    snapshot,
    providerUsage,
    ...projectContextCompactions(current.cycles),
  };
}

function reduceContextSnapshot(current, event) {
  if (
    !canReplaceContextWindowEvidence(current.latestSnapshotObservation, event)
  )
    return current;
  const measurement = selectContextInputMeasurement(event);
  if (!measurement && !hasOrderedContextEvidence(event)) return current;
  const observation = {
    ...event,
    availability: measurement ? "available" : "unavailable",
    measurement,
  };
  return {
    ...current,
    latestSnapshotObservation: observation,
    lastValidSnapshot: measurement ? observation : current.lastValidSnapshot,
  };
}

function reduceContextProviderUsage(current, event) {
  if (typeof event.invocationId !== "string" || !event.invocationId.trim())
    return current;
  const counts = normalizeContextProviderCounts(event);
  if (!counts) return current;
  const previous = current.usageByInvocation.get(event.invocationId);
  if (!canReplaceContextWindowEvidence(previous, event)) return current;
  const usage = {
    ...event,
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    ...counts,
    source: "provider_reported",
  };
  return {
    ...current,
    usageByInvocation: new Map(current.usageByInvocation).set(
      event.invocationId,
      usage,
    ),
  };
}

function hasCurrentContextStateScope(previous, scope) {
  if (!previous) return false;
  for (const key of [
    "requestId",
    "generation",
    "environmentId",
    "sessionId",
    "viewVersion",
  ]) {
    if (previous[key] !== scope[key]) return false;
  }
  return true;
}

export function reduceContextWindowEvidence(previous, message, scope) {
  if (!belongsToContextEvidenceScope(message, scope)) return previous;
  if (canBindInitialGeneration(message, scope))
    scope = {
      ...scope,
      generation: message.generation,
      generationSource: "event",
    };
  const event = bindContextEvidence(message, scope);
  const hasContextEvent =
    event.name?.startsWith("context.window.") ||
    event.name?.startsWith("context.compaction.");
  if (!hasContextEvent && !isRequestTerminalEvidence(event, scope))
    return previous;
  const current = hasCurrentContextStateScope(previous, scope)
    ? previous
    : createContextWindowState(scope);
  let next = current;
  if (event.name === "context.window.snapshot")
    next = reduceContextSnapshot(current, event);
  if (event.name === "context.window.provider_usage")
    next = reduceContextProviderUsage(current, event);
  if (event.name?.startsWith("context.compaction.")) {
    const cycles = reduceContextCompaction(
      current.cycles,
      event,
      current.requestTerminal,
    );
    if (cycles !== current.cycles) next = { ...current, cycles };
  }
  if (isRequestTerminalEvidence(event, scope)) {
    if (!canReplaceContextWindowEvidence(current.requestTerminal, event))
      return previous;
    next = {
      ...current,
      requestTerminal: event,
      cycles: interruptContextCompactions(current.cycles, event),
    };
  }
  if (next === current) return previous;
  return projectContextWindowState(next);
}

export function synchronizeContextRequestLifecycle(
  state,
  message,
  environmentId,
) {
  const lifecycle = message.lifecycle;
  const requestId = lifecycle.requestId;
  if (state.requestLifecycles?.get(requestId) !== lifecycle) return;
  const previous = state.contextWindowByRequest.get(requestId);
  if (previous && previous.generation !== lifecycle.generation)
    state.contextWindowByRequest.delete(requestId);
  const current = state.contextWindowByRequest.get(requestId);
  const scope = {
    ...contextEvidenceScope(state, environmentId, requestId),
    acceptedLifecycle: true,
  };
  const next = reduceContextWindowEvidence(
    current,
    { ...message, requestId, generation: lifecycle.generation },
    scope,
  );
  if (next && next !== current)
    state.contextWindowByRequest.set(requestId, next);
}

export function projectContextWindowDisplay(contextWindow, requestId) {
  if (!contextWindow || contextWindow.requestId !== requestId) return null;
  const snapshot = contextWindow.snapshot;
  if (!snapshot || snapshot.availability !== "available") return null;
  const { lastCompaction, providerUsage } = contextWindow;
  return {
    ...snapshot,
    measurement: snapshot.measurementKind,
    providerUsage,
    compaction: lastCompaction,
  };
}
