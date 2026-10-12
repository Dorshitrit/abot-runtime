import { ComposerSubmissionRefused, isDefiniteSubmissionRefusal } from "./composer-submission-lifecycle.js";

const scopeKey = (scope) => JSON.stringify([scope.environmentId, scope.sessionId]);

function hasConversationQueueScope(scope) {
  if (!scope.environmentId) return false;
  return Boolean(scope.sessionId);
}

/** Sole owner of queue ordering. Drafts and submissions own their respective payloads. */
export function createComposerQueueController({
  queue, drafts, lifecycle, getDraft, requests, getSettings,
  isCurrentScope, reportFailure, reportRecovery = () => {}, onChange = () => {},
  confirmTakeover = (message) => globalThis.confirm?.(message) === true,
}) {
  const processing = new Map();
  const bindings = new Map();
  const terminals = new Map();

  function queuedCount() {
    const scope = getDraft().scope;
    if (!hasConversationQueueScope(scope)) return 0;
    return queue.list(scope).length;
  }
  function isCurrentDraining() { return processing.has(scopeKey(getDraft().scope)); }

  function queueItem(payload, settings, requestId) {
    return { text: payload.text, attachments: [...payload.attachments], ...settings, waitForRequestId: requestId };
  }

  async function prepareManualSend(attempt) {
    const { payload, settings } = attempt;
    if (!payload.release) return;
    const { scope, release } = payload;
    const item = queueItem(payload, settings, release.item.waitForRequestId);
    const updated = await queue.updateBlockedRelease(scope, release.releaseToken, item);
    if (!updated) throw new ComposerSubmissionRefused("This queued message changed in another window. Reload before sending it.");
    const begun = await queue.beginBlockedSend(scope, release.releaseToken);
    if (!begun) throw new ComposerSubmissionRefused("This window no longer owns the queued message. Reload before sending it.");
  }

  async function send(attempt) {
    try { return await requests.send(attempt); }
    catch (error) {
      if (attempt.payload.release && !isDefiniteSubmissionRefusal(error)) {
        try { await queue.markBlockedUncertain(attempt.payload.scope, attempt.payload.release.releaseToken); }
        catch (markError) { reportFailure(attempt.payload.scope, `The queued message remains paused: ${markError.message}`); }
      }
      throw error;
    }
  }

  async function prepareRestore(attempt) {
    const { payload } = attempt;
    // Only a confirmed request rejection can return a sending lease to editing.
    // A failed preparation has not submitted anything and retains its existing lease.
    if (!payload.release || attempt.phase !== "sending") return payload;
    const claimed = await queue.claimBlockedRelease(payload.scope, payload.release.releaseToken, { takeover: true });
    if (!claimed) throw new Error("The rejected message remains paused because its queue ownership changed.");
    return { ...payload, release: claimed };
  }

  async function bindAccepted(attempt, requestId) {
    const { scope, release } = attempt.payload;
    if (!release) { requests.activate(attempt, requestId); return; }
    const key = scopeKey(scope);
    const binding = Promise.resolve().then(async () => {
      const bound = await queue.bindReleasedSuccess(scope, release.releaseToken, requestId);
      if (!bound) throw new Error("The remaining queue could not be bound to the accepted request.");
      return true;
    }).catch((error) => {
      reportFailure(scope, `The request started, but the remaining Send next queue is paused: ${error.message}`);
      return false;
    });
    bindings.set(key, binding);
    onChange();
    requests.activate(attempt, requestId);
    try { await binding; }
    finally {
      if (bindings.get(key) === binding) bindings.delete(key);
      onChange();
    }
  }

  async function enqueue(attempt, waitForRequestId) {
    if (!waitForRequestId) throw new ComposerSubmissionRefused("Send next requires an active request.");
    try { return await queue.enqueue(attempt.payload.scope, queueItem(attempt.payload, attempt.settings, waitForRequestId)); }
    catch (error) {
      if (error?.workspaceMutationMayHaveCommitted !== true)
        throw new ComposerSubmissionRefused(error.message, { cause: error });
      throw error;
    }
  }

  function hasManualRecovery(scope) {
    if (!hasConversationQueueScope(scope)) return false;
    if (bindings.has(scopeKey(scope))) return false;
    if (lifecycle.hasPendingScope(scope)) return false;
    const release = queue.getBlockedRelease(scope);
    if (!release) return false;
    if (drafts.open(scope).release?.releaseToken === release.releaseToken) return false;
    return !lifecycle.paused(scope).some((attempt) => attempt.payload.release?.releaseToken === release.releaseToken);
  }

  async function recoverForManualSend(scope) {
    const draft = drafts.open(scope);
    const release = queue.getBlockedRelease(scope);
    if (!release || draft.release?.releaseToken === release.releaseToken) return false;
    if (!draft.isEmpty()) {
      reportFailure(scope, "Send next is paused. Finish or clear your current draft before reviewing the queued message.");
      return false;
    }
    let claimed = await queue.claimBlockedRelease(scope, release.releaseToken);
    if (!claimed) {
      const approved = confirmTakeover("This queued message may have been sent or may belong to another window. Close that window and check the conversation before taking ownership for manual review. Sending it again may repeat its actions. Continue?");
      if (!approved) return false;
      claimed = await queue.claimBlockedRelease(scope, release.releaseToken, { takeover: true });
    }
    if (!claimed) throw new Error("This queued message changed before it could be recovered.");
    // Ownership can be acknowledged after navigation. Restore only to its own draft,
    // and never merge a second recovery over input typed during that acknowledgement.
    if (!draft.isEmpty()) return false;
    draft.restore({ scope, text: claimed.item.text, attachments: claimed.item.attachments, release: claimed });
    onChange();
    reportRecovery(scope, "Send next is paused. Review the recovered message and send it manually when ready.");
    return true;
  }

  function prepareRecoveryForNavigation() {
    const draft = getDraft();
    if (!draft.release) return () => {};
    return persistRecoveryDraft(draft);
  }

  async function persistRecoveryDraft(draft) {
    const snapshot = draft.snapshot();
    const revision = draft.revision;
    try {
      const updated = await queue.updateBlockedRelease(snapshot.scope, snapshot.release.releaseToken,
        queueItem(snapshot, getSettings(), snapshot.release.item.waitForRequestId));
      if (!updated) throw new Error("The queued message changed in another window.");
      const commit = () => {};
      commit.canCommit = () => draft.revision === revision;
      return commit;
    } catch (error) {
      reportFailure(snapshot.scope, `The recovered draft could not be saved: ${error.message}`);
      return false;
    }
  }

  function suspendRecoveryForNavigation(canNavigate = () => true) {
    const prepared = prepareRecoveryForNavigation();
    const commit = (action) => {
      if (!action || !canNavigate() || action.canCommit?.() === false) return false;
      action();
      return true;
    };
    return typeof prepared?.then === "function" ? prepared.then(commit) : commit(prepared);
  }

  async function processTerminal(input) {
    const scope = { environmentId: input.environmentId, sessionId: input.sessionId };
    const binding = bindings.get(scopeKey(scope));
    if (binding && await binding !== true) return;
    const released = await queue.releaseForTerminal(scope, input.terminalRequestId);
    if (!released) return;
    if (input.cancelled) { await recoverForManualSend(scope); return; }
    const item = released.item;
    const attempt = await lifecycle.submitCaptured({
      action: "send", payload: { scope, text: item.text, attachments: item.attachments, release: released },
      settings: { agentMode: item.agentMode, toolPermissionMode: item.toolPermissionMode, modelPreference: item.modelPreference },
      prepare: async (submission) => { await prepareManualSend(submission); requests.prepareView(submission); },
      execute: send, accepted: bindAccepted, prepareRestore,
    });
    if (attempt.status !== "accepted")
      reportFailure(scope, "The queued message could not be confirmed. It is paused and will not be retried automatically.");
  }

  function drain(input) {
    const key = scopeKey(input);
    let pending = terminals.get(key);
    if (!pending) { pending = new Map(); terminals.set(key, pending); }
    pending.set(input.terminalRequestId, input);
    if (processing.has(key)) return processing.get(key);
    const operation = Promise.resolve().then(async () => {
      while (pending.size) {
        const [requestId, terminal] = pending.entries().next().value;
        pending.delete(requestId);
        try { await processTerminal(terminal); }
        catch (error) { reportFailure(input, `Send next remains paused: ${error.message}`); }
      }
    }).finally(() => {
      processing.delete(key);
      terminals.delete(key);
      onChange();
    });
    processing.set(key, operation);
    onChange();
    return operation;
  }

  return {
    queuedCount, isCurrentDraining, enqueue, prepareManualSend, send, bindAccepted, drain, prepareRestore,
    recoverForManualSend, hasManualRecovery, prepareRecoveryForNavigation, suspendRecoveryForNavigation,
    isCurrentScope, scopeKey, currentScope: () => getDraft().scope, reportFailure,
    async authorizeReview(attempt) {
      if (!attempt.payload.release) return true;
      const { scope, release } = attempt.payload;
      const claimed = await queue.claimBlockedRelease(scope, release.releaseToken, { takeover: true });
      return claimed ? { release: claimed } : false;
    },
    ownsAttachment(attachment) {
      const scope = { environmentId: attachment.environment, sessionId: attachment.sessionId };
      if (!scope.environmentId || !scope.sessionId) return false;
      const release = queue.getBlockedRelease(scope);
      const items = [...queue.list(scope), ...(release ? [release.item] : [])];
      return items.some((item) => item.attachments.some((file) => file.id === attachment.id && file.storageRef === attachment.storageRef));
    },
  };
}
