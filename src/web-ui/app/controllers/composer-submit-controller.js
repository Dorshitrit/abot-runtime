import { resolveComposerPrimaryAction } from "../ui-behavior.js";
import { createComposerStopController } from "./composer-stop-controller.js";
import { hasWaitingApproval, waitingRequest } from "../lib/request-lifecycle-view.js";

/** UI intent only. The shared submission lifecycle owns all payload transitions. */
export function createComposerSubmitController({
  state, dom, composerActions, getDraft, attachments, queue, lifecycle, submit,
  stopRequest, selectedEnvironmentId, setMessageStatus,
  getSubmissionBlock = () => null, onSubmissionBlocked = () => {},
  isComposerVisible = () => true, allowsActiveRequest = true,
}) {
  const stopping = createComposerStopController({ state, selectedEnvironmentId,
    setMessageStatus, updateSendState, stopRequest });

  function resize() {
    if (!isComposerVisible()) return;
    dom.composerInput.style.height = "auto";
    dom.composerInput.style.height = `${Math.min(dom.composerInput.scrollHeight, 168)}px`;
  }
  function isBusy() {
    if (lifecycle.hasPendingScope(getDraft().scope)) return true;
    return allowsActiveRequest && queue.isCurrentDraining();
  }
  function cannotSubmit() {
    if (stopping.isStopping()) return true;
    if (allowsActiveRequest && hasWaitingApproval(state)) return true;
    if (getSubmissionBlock()) return true;
    if (!dom.composerInput.value.trim()) return true;
    if (isBusy()) return true;
    return attachments.activeUploadCount() > 0;
  }
  function updateSendState() {
    if (!isComposerVisible()) return;
    composerActions.render({
      activeRequestId: allowsActiveRequest ? state.activeRequestId : "",
      waitingRequestId: allowsActiveRequest ? waitingRequest(state)?.requestId : "",
      stopping: stopping.isStopping(),
      onStop: () => { if (isComposerVisible()) void stopping.stop(); },
      attachmentCount: getDraft().attachments.length,
      busy: isBusy(), disabled: cannotSubmit(), queuedCount: allowsActiveRequest ? queue.queuedCount() : 0,
    });
  }
  function dispatch(requestedAction = "") {
    if (!isComposerVisible()) return;
    const block = getSubmissionBlock();
    if (block) { onSubmissionBlocked(block); updateSendState(); return; }
    if (cannotSubmit()) return;
    let action = requestedAction || composerActions.primaryAction();
    if (!allowsActiveRequest) action = "send";
    if (allowsActiveRequest && state.activeRequestId && action === "send")
      action = resolveComposerPrimaryAction(state.activeRequestId, getDraft().attachments.length);
    setMessageStatus(submissionStatus(action), true);
    // submit synchronously takes text and files before its first await.
    const submittedScope = getDraft().scope;
    const operation = submit(action);
    resize();
    updateSendState();
    return operation.catch((error) => {
      setMessageStatus(error.message);
      return { status: "blocked", error };
    }).finally(() => {
      updateSendState();
      if (isSameComposerScope(submittedScope, getDraft().scope) && isComposerVisible()) dom.composerInput.focus();
    });
  }
  return { dispatch, resize, updateSendState, stop: () => isComposerVisible() && stopping.stop() };
}

function submissionStatus(action) {
  if (action === "steer") return "Sending an update to the active request.";
  if (action === "send_next") return "Queueing the next message.";
  return "ABot is working.";
}

function isSameComposerScope(submitted, current) {
  if (submitted.environmentId !== current.environmentId) return false;
  return submitted.sessionId === current.sessionId;
}
