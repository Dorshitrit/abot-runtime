import { createComposerDrafts } from "./composer-drafts.js";
import { createComposerSubmissionLifecycle, ComposerSubmissionRefused } from "./composer-submission-lifecycle.js";
import { createComposerAttachmentsController } from "./composer-attachments-controller.js";
import { createComposerQueueController } from "./composer-queue-controller.js";
import { createComposerSubmitController } from "./composer-submit-controller.js";
import { createChatRequestController } from "./chat-request-controller.js";
import { createComposerSubmissionNotice } from "../components/composer-submission-notice.js";

/** Production composition reused by Chat/Home and the SPARK popup, and integration tests. */
export function createComposerFeature({
  state, dom, shell, client, sessionQueue, conversationSession, conversationView,
  getEnvironmentId, getDraft, ensureSession, getSettings, steer,
  composerActions, selectedModelSupportsImageInput, isComposerAvailable,
  getSubmissionBlock, onSubmissionBlocked, isVisible = () => true,
  renderSessions, renderMessages, applyConversationChrome, setMessageStatus, recordControlEvent,
  drafts = createComposerDrafts(), onChange = () => {},
  confirmReview = (message) => globalThis.confirm?.(message) === true,
}) {
  const surfaces = [];
  let queue;
  const isCurrentScope = (scope) => getEnvironmentId() === scope.environmentId && state.currentSessionId === scope.sessionId;
  function reportStatus(scope, message, tone) {
    const hasVisibleDraft = surfaces.some((surface) => surface.displays(scope));
    if (!isCurrentScope(scope) && !hasVisibleDraft) return;
    setMessageStatus(message);
    recordControlEvent({ type: "control", name: "Composer message paused", tone, summary: message });
  }
  const reportFailure = (scope, message) => reportStatus(scope, message, "failed");
  const reportRecovery = (scope, message) => reportStatus(scope, message, "neutral");
  function changed() {
    for (const surface of surfaces) surface.render();
    onChange();
  }
  const lifecycle = createComposerSubmissionLifecycle({ drafts, onChange: changed });
  Object.defineProperty(state, "composerSending", { configurable: true, get: () => lifecycle.hasPendingScope(getDraft().scope) });
  Object.defineProperty(state, "pendingAttachments", { configurable: true, get: () => getDraft().attachments });
  const requests = createChatRequestController({ client, conversationView, conversationSession,
    isCurrentComposerScope: isCurrentScope, applyConversationChrome, renderSessions });
  queue = createComposerQueueController({ queue: sessionQueue, drafts, lifecycle, getDraft, requests, getSettings,
    isCurrentScope, reportFailure, reportRecovery, onChange: changed, confirmTakeover: confirmReview });

  function createSurface({ surfaceDom, currentDraft, ensureDraftSession, visible, supportsImages,
    available = isComposerAvailable, prepareSend = () => true, allowsActiveRequest = true }) {
    const attachments = createComposerAttachmentsController({
      getDraft: currentDraft, dom: surfaceDom, shell, client, selectedEnvironmentId: getEnvironmentId,
      selectedModelSupportsImageInput: supportsImages, ensureSession: ensureBoundSession,
      isComposerAvailable: available, isComposerVisible: visible,
      onSendStateChange: () => submit.updateSendState(), onControlEvent: recordControlEvent,
      canDeleteAttachment: (file) => !drafts.contains(file) && !lifecycle.ownsAttachment(file) && !queue.ownsAttachment(file),
    });
    const notice = createComposerSubmissionNotice({ form: surfaceDom.composerForm, review: async (attempt) => {
      if (!confirmReview("Check the conversation first: this message may already have been sent. Restore it for manual review? Sending it again may repeat its actions.")) return;
      try { await lifecycle.restoreForManualReview(attempt.id, queue.authorizeReview); }
      catch (error) { reportFailure(attempt.payload.scope, error.message); }
    }, recover: async (scope) => {
      try { await queue.recoverForManualSend(scope); }
      catch (error) { reportFailure(scope, error.message); }
      changed();
    } });
    function render() {
      if (!visible()) { notice.render([]); return; }
      attachments.render();
      submit.updateSendState();
      const draft = currentDraft();
      const recovery = queue.hasManualRecovery(draft.scope)
        ? { scope: draft.scope, draftEmpty: draft.isEmpty() } : null;
      notice.render(lifecycle.paused(draft.scope), recovery);
    }
    function ensureBoundSession() {
      const draft = currentDraft();
      const sessionId = ensureDraftSession();
      drafts.assignSession(draft, sessionId);
      return sessionId;
    }
    function send(action) {
      let draft = currentDraft();
      draft.text = surfaceDom.composerInput.value.trim();
      const settings = getSettings();
      if (!draft.scope.sessionId) { ensureBoundSession(); draft = currentDraft(); }
      const activeRequestId = allowsActiveRequest ? state.activeRequestId : "";
      return lifecycle.submit({ draft, action, settings,
        prepare: async (attempt) => {
          if (attempt.payload.release && activeRequestId)
            throw new ComposerSubmissionRefused("Wait for the active request to finish before sending this recovered message.");
          if (attempt.payload.release && action !== "send")
            throw new ComposerSubmissionRefused("A recovered queued message must be sent directly after review.");
          if (action !== "send") return;
          if (await prepareSend(attempt.payload) === false)
            throw new ComposerSubmissionRefused("Conversation navigation was cancelled. Your draft was kept.");
          await queue.prepareManualSend(attempt);
          requests.prepareView(attempt);
        },
        execute: (attempt) => {
          if (action === "send_next") return queue.enqueue(attempt, activeRequestId);
          if (action === "steer") return steer(attempt.payload.text, { scope: { ...attempt.payload.scope, requestId: activeRequestId }, pendingAttachmentCount: attempt.payload.attachments.length });
          return queue.send(attempt);
        },
        prepareRestore: queue.prepareRestore,
        accepted: async (attempt, result) => {
          if (action === "send") await queue.bindAccepted(attempt, result);
        },
      }).then((result) => {
        if (result.status === "refused") reportFailure(result.attempt.payload.scope, result.error.message);
        if (result.status === "uncertain") reportFailure(result.attempt.payload.scope, "The message could not be confirmed. It is paused for manual review.");
        return result;
      });
    }
    const submit = createComposerSubmitController({ state, dom: surfaceDom, composerActions,
      getDraft: currentDraft, attachments, queue, lifecycle, submit: send,
      stopRequest: requests.stopRequest, selectedEnvironmentId: getEnvironmentId, setMessageStatus,
      getSubmissionBlock, onSubmissionBlocked, isComposerVisible: visible, allowsActiveRequest });
    const surface = { attachments, submit, render, displays: (scope) => {
      if (!visible()) return false;
      const current = currentDraft().scope;
      return current.environmentId === scope.environmentId && current.sessionId === scope.sessionId;
    } };
    surfaces.push(surface);
    return surface;
  }
  const chat = createSurface({ surfaceDom: dom, currentDraft: getDraft, ensureDraftSession: ensureSession,
    visible: isVisible, supportsImages: selectedModelSupportsImageInput });
  drafts.subscribe(changed);
  return { ...chat, queue, requests, drafts, lifecycle, createSurface, changed };
}
