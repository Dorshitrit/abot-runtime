import { normalizeRealtimeMessage } from "../lib/realtime-message.js";
import { contextReplayBinding } from "../lib/context-window-replay.js";

/** Owns only suggestion presentation and explicit config actions, never chat state. */
export function createStepTimeoutController({ client, getScope, render, isReplayCurrent = () => false, onApplied = () => {} }) {
  let scopeKey = "";
  let generation = 0;
  let current = null;
  const seen = new Set();
  const currentScopeKey = () => JSON.stringify(getScope());

  function syncScope() {
    const next = currentScopeKey();
    if (scopeKey === next && (!current?.replay || isReplayCurrent(current.replay))) return;
    scopeKey = next;
    generation += 1;
    current = null;
    render(null);
  }

  function ownsSuggestion(captured) {
    if (captured.generation !== generation) return false;
    if (captured.scopeKey !== currentScopeKey()) return false;
    if (captured.replay && !isReplayCurrent(captured.replay)) return false;
    return true;
  }

  function isCurrentConversationTimeout(message, scope) {
    if (scope.backend !== "runtime" || scope.workspace !== "chat") return false;
    if (message.name !== "model.step.timed_out") return false;
    if (!message.requestId || !message.invocationId) return false;
    const replay = contextReplayBinding(message);
    if (replay) return isCurrentTimeoutReplay(message, replay);
    if (!message.sessionId) return false;
    if (message.environment !== scope.environment) return false;
    return message.sessionId === scope.sessionId;
  }

  function isCurrentTimeoutReplay(message, replay) {
    if (replay.requestId !== message.requestId) return false;
    return isReplayCurrent(replay);
  }

  async function handle(raw) {
    syncScope();
    const message = normalizeRealtimeMessage(raw);
    const scope = getScope();
    if (!isCurrentConversationTimeout(message, scope)) return;
    const identity = {
      environment: scope.environment, sessionId: scope.sessionId,
      requestId: message.requestId, invocationId: message.invocationId,
    };
    const key = JSON.stringify(identity);
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 128) seen.delete(seen.values().next().value);
    // A subsequent failure must not replace a save/restart already chosen by the user.
    if (current?.busy || current?.saved) return;
    const replay = contextReplayBinding(message);
    const captured = { generation: ++generation, scopeKey, replay };
    current = null;
    render(null);
    try {
      const result = await client.inspectStepTimeout(identity);
      if (!ownsSuggestion(captured)) return;
      if (!result?.suggestion) return;
      current = { identity, replay, suggestion: result.suggestion, busy: false, saved: false, applied: false, message: "" };
      render(current);
    } catch {
      // A missing/stale receipt must not add a second failure to the conversation.
    }
  }

  async function increase() {
    syncScope();
    if (!current || current.busy || current.applied) return;
    if (!current.suggestion.canIncrease) return;
    const captured = { generation, scopeKey, replay: current.replay };
    const target = current;
    target.busy = true;
    target.message = target.saved ? "Restarting idle Runtime…" : "Saving timeout…";
    render(target);
    try {
      if (!target.saved) {
        await client.increaseStepTimeout(target.identity, target.suggestion.revision);
        if (!ownsSuggestion(captured)) return;
        target.saved = true;
      }
      target.message = "Saved. Restarting idle Runtime…";
      render(target);
      const result = await client.applyRuntimeConfiguration(target.identity.environment);
      if (!ownsSuggestion(captured)) return;
      if (result?.activation?.status !== "ready") {
        target.message = `Saved. ${result?.activation?.message || "Restart when Runtime is idle, or restart it manually later."}`;
        return;
      }
      target.applied = true;
      target.message = "Timeout updated. Runtime is ready for your next request.";
      await onApplied();
    } catch (error) {
      if (!ownsSuggestion(captured)) return;
      if (target.applied) {
        target.message = "Runtime restarted with the new timeout. Reload the page to refresh model settings.";
        return;
      }
      target.message = `${target.saved ? "Saved; restart not confirmed. " : ""}${error.message || String(error)}`;
    } finally {
      if (ownsSuggestion(captured)) { target.busy = false; render(target); }
    }
  }

  function dismiss() {
    generation += 1;
    current = null;
    render(null);
  }

  return { handle, syncScope, increase, dismiss };
}
