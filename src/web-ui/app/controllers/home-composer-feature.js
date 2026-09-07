import { createComposerAttachmentsController } from "./composer-attachments-controller.js";
import { createComposerSubmitController } from "./composer-submit-controller.js";

export function createHomeComposerFeature({
  workspace,
  shell,
  client,
  composerActions,
  selectedEnvironmentId,
  selectedModelSupportsImageInput,
  isComposerAvailable,
  getSubmissionBlock,
  onSubmissionBlocked,
  onControlEvent,
  onStateChange,
  activateHomeSession,
  sendMessage,
}) {
  const attachments = createComposerAttachmentsController({
    state: workspace.homeState,
    dom: workspace.homeDom,
    shell,
    client,
    selectedEnvironmentId,
    selectedModelSupportsImageInput,
    ensureSession: workspace.ensureHomeSession,
    isComposerAvailable,
    isComposerVisible: workspace.isHome,
    onSendStateChange: onStateChange,
    onControlEvent,
  });

  async function sendHomeMessage(text) {
    const draft = workspace.takeHomeDraft(text);
    let activated = false;
    try {
      activated = activateHomeSession(draft) !== false;
    } catch (error) {
      workspace.restoreHomeDraft(draft);
      attachments.render();
      throw error;
    }
    if (!activated) {
      workspace.restoreHomeDraft(draft);
      attachments.render();
      return;
    }
    await sendMessage(text);
  }

  function reportRequestError(error) {
    onControlEvent({
      type: "control",
      name: "Message could not be sent",
      tone: "failed",
      summary: error instanceof Error ? error.message : String(error),
    });
  }

  const submit = createComposerSubmitController({
    state: workspace.homeState,
    dom: workspace.homeDom,
    composerActions,
    attachments,
    queue: {
      isCurrentDraining: () => false,
      queuedCount: () => 0,
    },
    chatRequests: { sendMessage: sendHomeMessage },
    conversationSession: { appendRequestError: reportRequestError },
    selectedEnvironmentId,
    setMessageStatus: () => {},
    getSubmissionBlock,
    onSubmissionBlocked,
    isComposerVisible: workspace.isHome,
  });

  function environmentChanged() {
    if (workspace.homeState.environmentId === selectedEnvironmentId()) return;
    attachments.clear();
    workspace.resetHomeDraft();
    if (workspace.isHome()) workspace.ensureHomeSession();
  }

  function render() {
    workspace.syncChatDraft();
    environmentChanged();
    if (!workspace.isHome()) return;
    attachments.render();
    submit.resize();
    submit.updateSendState();
  }

  function setWorkspace(destination) {
    environmentChanged();
    workspace.setWorkspace(destination);
    render();
  }

  function dispatch() {
    environmentChanged();
    submit.dispatch("send");
  }

  async function upload(file) {
    environmentChanged();
    await attachments.upload(file);
  }

  return {
    attachments,
    submit,
    setWorkspace,
    environmentChanged,
    dispatch,
    upload,
    render,
  };
}
