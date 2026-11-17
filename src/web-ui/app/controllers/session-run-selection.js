import { contextReplayBinding } from "../lib/context-window-replay.js";
import { normalizedRunSelection, recordedRunReasoning, sameRunReasoning, sameRunSelectionPresentation } from "./session-run-selection-evidence.js";

const scopeKey = (scope) => JSON.stringify([scope.environmentId, scope.sessionId]);

function matchesRunScope(candidate, current) {
  if (candidate.environmentId !== current.environmentId) return false;
  if (candidate.sessionId !== current.sessionId) return false;
  if (candidate.viewVersion === undefined) return true;
  return candidate.viewVersion === current.viewVersion;
}

function canReplaceRun(previous, next) {
  if (!previous) return true;
  if (next.selectedAt < previous.selectedAt) return false;
  if (next.selectedAt > previous.selectedAt) return true;
  return previous.requestId === next.requestId;
}

function changesPendingModel(previous, fields, currentProfileId) {
  if (!Object.hasOwn(fields, "profileId")) return false;
  return fields.profileId !== (previous?.profileId || currentProfileId);
}

function reasoningPreferenceForProfile(preference, profileId) {
  if (preference?.profileId !== profileId) return undefined;
  return preference;
}

function pendingReasoningForProfile(pending, currentProfileId, profileId, saved) {
  const boundProfileId = pending.reasoningPreference?.profileId || pending.profileId || currentProfileId;
  if (boundProfileId && boundProfileId !== profileId) return saved;
  return pending.reasoningPreference;
}

/** Observed execution and the user's unsent choice have separate lifetimes. */
export function createSessionRunSelection({ getScope, getComposerScope, isHome = () => false, getRequestGeneration = () => undefined, hasUnsentDraft = () => true, getSubmissionScopes = () => [] }) {
  let observed = null;
  let observedScope = null;
  let lastReasoningSequence = 0;
  const overrides = new Map();

  function run() {
    if (isHome()) return null;
    if (!observedScope || !matchesRunScope(observedScope, getScope())) return null;
    if (scopeKey(getComposerScope()) !== scopeKey(getScope())) return null;
    return observed;
  }
  function override() {
    if (isHome()) return null;
    return overrides.get(scopeKey(getComposerScope())) || null;
  }
  function remember(fields) {
    if (isHome()) return;
    const key = scopeKey(getComposerScope());
    const previous = overrides.get(key);
    const pending = { ...previous };
    if (changesPendingModel(previous, fields, run()?.primaryProfileId)) delete pending.reasoningPreference;
    overrides.set(key, { ...pending, ...fields, requestId: run()?.requestId });
  }
  function adopt(next, scope) {
    if (!matchesRunScope(scope, getScope())) return false;
    const previous = observedScope && matchesRunScope(observedScope, scope) ? observed : null;
    if (!canReplaceRun(previous, next)) return false;
    const key = scopeKey(scope);
    const pending = overrides.get(key);
    const retiredChoice = Boolean(pending && pending.requestId !== next.requestId);
    if (retiredChoice) overrides.delete(key);
    if (previous?.requestId !== next.requestId) lastReasoningSequence = 0;
    const snapshotSequence = next.reasoningEventSequence;
    if (lastReasoningSequence && snapshotSequence === undefined) next.effectiveReasoning = previous?.effectiveReasoning;
    if (Number.isSafeInteger(snapshotSequence) && snapshotSequence > 0) {
      if (snapshotSequence < lastReasoningSequence) next.effectiveReasoning = previous?.effectiveReasoning;
      lastReasoningSequence = Math.max(lastReasoningSequence, snapshotSequence);
    }
    observed = next;
    observedScope = { ...scope };
    return retiredChoice || !sameRunSelectionPresentation(previous, next);
  }
  function applySnapshot(payload, scope) {
    if (payload?.sessionId !== scope.sessionId) return false;
    const next = normalizedRunSelection(payload.modelSelection);
    if (!next) return false;
    return adopt(next, scope);
  }
  function observeEvent(message) {
    const replay = contextReplayBinding(message);
    const scope = replay || {
      environmentId: message.environmentId || message.environment,
      sessionId: message.sessionId,
    };
    if (!matchesRunScope(scope, getScope())) return false;
    if (replay && observed && message.requestId !== observed.requestId) return false;
    const generation = message.generation || replay?.generation;
    const currentGeneration = getRequestGeneration(message.requestId);
    if (currentGeneration && generation !== currentGeneration) return false;
    if (replay?.generation && generation !== replay.generation) return false;
    if (observed?.requestId === message.requestId && observed.generation && generation !== observed.generation) return false;
    if (message.name === "request.model.selected") {
      const next = normalizedRunSelection(message);
      if (!next) return false;
      next.status = "streaming";
      if (observed?.requestId === next.requestId) {
        next.status = observed.status || next.status;
        next.effectiveReasoning = observed.effectiveReasoning;
      }
      return adopt(next, { ...getScope(), ...scope });
    }
    if (!observed || !observedScope || !matchesRunScope(observedScope, getScope())) return false;
    if (message.requestId !== observed.requestId) return false;
    if (message.type === "completed" || message.type === "failed") {
      if (observed.status === message.type) return false;
      observed = { ...observed, status: message.type };
      return true;
    }
    if (message.name !== "context.window.snapshot") return false;
    if (message.admissionOutcome !== "accepted") return false;
    if (!observed.rootModelSteps.includes(message.modelStep)) return false;
    // Original Runtime sequence is stable across transport/replay sequence domains.
    const sequence = Number.isSafeInteger(message.eventSequence) ? message.eventSequence : 0;
    if (sequence && sequence <= lastReasoningSequence) return false;
    if (!sequence && replay && lastReasoningSequence) return false;
    if (sequence) lastReasoningSequence = sequence;
    const effectiveReasoning = message.profileId === observed.primaryProfileId ? recordedRunReasoning(message) : undefined;
    const changed = !sameRunReasoning(observed.effectiveReasoning, effectiveReasoning);
    observed = { ...observed, effectiveReasoning };
    return changed;
  }
  function reasoningRun(profileId) {
    const current = run(), pending = override();
    if (!current || current.primaryProfileId !== profileId) return null;
    if (pending && Object.hasOwn(pending, "agentMode")) return null;
    if (pending && Object.hasOwn(pending, "reasoningPreference")) return null;
    if (pending?.profileId && pending.profileId !== profileId) return null;
    return current;
  }
  function pruneEmptyDraftSelections(scope) {
    let retired = false;
    const submittedScopes = new Set();
    for (const submitted of getSubmissionScopes()) submittedScopes.add(scopeKey(submitted));
    const entries = scope ? [[scopeKey(scope), scope]] : [...overrides.keys()].map((key) => {
      const [environmentId, sessionId] = JSON.parse(key);
      return [key, { environmentId, sessionId }];
    });
    for (const [key, target] of entries) {
      if (submittedScopes.has(key)) continue;
      if (hasUnsentDraft(target)) continue;
      retired = overrides.delete(key) || retired;
    }
    return retired;
  }
  return {
    run, override, remember, applySnapshot, observeEvent, reasoningRun,
    pruneEmptyDraftSelections,
    retireSessionSelection: (scope) => overrides.delete(scopeKey(scope)),
    clear() { observed = null; observedScope = null; lastReasoningSequence = 0; },
    selectedProfileId(fallback) { return override()?.profileId || run()?.primaryProfileId || fallback; },
    profileIdForSession(scope, fallback) {
      const pending = overrides.get(scopeKey(scope));
      if (pending?.profileId) return pending.profileId;
      if (observedScope && scopeKey(observedScope) === scopeKey(scope)) return observed?.primaryProfileId || fallback;
      return fallback;
    },
    selectedAgentMode(fallback) { return override()?.agentMode || run()?.agentMode || fallback; },
    selectedReasoningPreference(profileId, fallback) {
      const pending = override();
      const saved = reasoningPreferenceForProfile(fallback, profileId);
      if (pending && Object.hasOwn(pending, "reasoningPreference"))
        return pendingReasoningForProfile(pending, run()?.primaryProfileId, profileId, saved);
      if (pending?.profileId) return saved;
      const current = run();
      if (!current) return saved;
      if (current.primaryProfileId === profileId) return current.reasoningPreference;
      return saved;
    },
  };
}
