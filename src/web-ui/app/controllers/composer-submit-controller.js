import {
  captureComposerSubmissionScope,
  isCurrentComposerSubmissionScope,
} from "../lib/composer-submission-scope.js";
import { resolveComposerPrimaryAction } from "../ui-behavior.js";
import { createComposerStopController } from "./composer-stop-controller.js";
import {
  hasWaitingApproval,
  waitingRequest,
} from "../lib/request-lifecycle-view.js";

export function createComposerSubmitController({
  state,
  dom,
  composerActions,
  attachments,
  queue,
  steer,
  chatRequests,
  conversationSession,
  selectedEnvironmentId,
  setMessageStatus,
  getSubmissionBlock = () => null,
  onSubmissionBlocked = () => {},
  isComposerVisible = () => true,
}) {
  const stopping = createComposerStopController({
    state,
    selectedEnvironmentId,
    setMessageStatus,
    updateSendState,
    stopRequest: (scope) => chatRequests.stopRequest(scope),
  });
  function resize() {
    if (!isComposerVisible()) return;
    dom.composerInput.style.height = "auto";
    dom.composerInput.style.height = `${Math.min(
      dom.composerInput.scrollHeight,
      168,
    )}px`;
  }

  function updateSendState() {
    if (!isComposerVisible()) return;
    const queueDraining = queue.isCurrentDraining();
    const submissionBlock = getSubmissionBlock();
    composerActions.render({
      activeRequestId: state.activeRequestId,
      waitingRequestId: waitingRequest(state)?.requestId,
      stopping: stopping.isStopping(),
      onStop: () => {
        if (isComposerVisible()) void stopping.stop();
      },
      attachmentCount: state.pendingAttachments.length,
      busy: state.composerSending || queueDraining,
      disabled:
        stopping.isStopping() ||
        hasWaitingApproval(state) ||
        Boolean(submissionBlock) ||
        !dom.composerInput.value.trim() ||
        state.composerSending ||
        queueDraining ||
        attachments.activeUploadCount() > 0,
      queuedCount: queue.queuedCount(),
    });
  }

  function dispatch(requestedAction = "") {
    if (!isComposerVisible()) return;
    if (stopping.isStopping()) return;
    if (hasWaitingApproval(state)) {
      setMessageStatus(
        "Decide or cancel the pending approval before sending a new message.",
      );
      return;
    }
    const text = dom.composerInput.value.trim();
    const submissionBlock = getSubmissionBlock();
    if (text && submissionBlock) {
      onSubmissionBlocked(submissionBlock);
      updateSendState();
      return;
    }
    if (
      !text ||
      state.composerSending ||
      queue.isCurrentDraining() ||
      attachments.activeUploadCount() > 0
    ) {
      return;
    }
    let action = requestedAction || composerActions.primaryAction();
    if (state.activeRequestId && action === "send") {
      action = resolveComposerPrimaryAction(
        state.activeRequestId,
        state.pendingAttachments.length,
      );
    }
    const submissionScope = {
      environmentId: selectedEnvironmentId(),
      sessionId: state.currentSessionId,
    };
    state.composerSending = true;
    setMessageStatus(
      action === "steer"
        ? "Sending an update to the active request."
        : action === "send_next"
          ? "Queueing the next message."
          : "ABot is working.",
      true,
    );
    updateSendState();
    dom.composerInput.value = "";
    resize();
    const operation =
      action === "steer"
        ? steer(text)
        : action === "send_next"
          ? queue.enqueue(text)
          : chatRequests.sendMessage(text);
    const completionScope = captureComposerSubmissionScope(
      state,
      selectedEnvironmentId(),
    );
    const isSubmissionForCurrentComposerView = () =>
      isCurrentComposerSubmissionScope(
        completionScope,
        state,
        selectedEnvironmentId(),
      );
    void operation
      .then(() => {
        if (!isSubmissionForCurrentComposerView()) return;
        if (action === "steer") {
          setMessageStatus("Update accepted. ABot is working.", true);
        } else if (action === "send_next") {
          setMessageStatus("Message queued for this conversation.", true);
        }
      })
      .catch((error) => {
        if (!isSubmissionForCurrentComposerView()) return;
        if (action !== "send") queue.restoreText(text, submissionScope);
        conversationSession.appendRequestError(error);
        setMessageStatus("ABot request failed.");
      })
      .finally(() => {
        if (!isSubmissionForCurrentComposerView()) return;
        state.composerSending = false;
        updateSendState();
        if (isComposerVisible()) dom.composerInput.focus();
      });
  }

  return {
    dispatch,
    resize,
    updateSendState,
    stop: () => isComposerVisible() && stopping.stop(),
  };
}
