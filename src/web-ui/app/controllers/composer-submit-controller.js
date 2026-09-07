import { captureComposerSubmissionScope, isCurrentComposerSubmissionScope } from "../lib/composer-submission-scope.js";
import { resolveComposerPrimaryAction } from "../ui-behavior.js";

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
      attachmentCount: state.pendingAttachments.length,
      busy: state.composerSending || queueDraining,
      disabled:
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
      state, selectedEnvironmentId(),
    );
    const isSubmissionForCurrentComposerView = () => isCurrentComposerSubmissionScope(
      completionScope, state, selectedEnvironmentId(),
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

  return { dispatch, resize, updateSendState };
}
