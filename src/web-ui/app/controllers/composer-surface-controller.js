export function createComposerSurfaceController({
  workspace,
  getHomeComposer,
  getChatAttachments,
  getChatSubmit,
  rememberModelSelection,
  showToast,
}) {
  function activeSubmit() {
    return workspace.isHome() ? getHomeComposer()?.submit : getChatSubmit();
  }
  function activeAttachments() {
    return workspace.isHome()
      ? getHomeComposer()?.attachments
      : getChatAttachments();
  }
  return {
    renderAttachmentComposer() {
      if (workspace.isHome()) {
        getHomeComposer()?.render();
        return;
      }
      getChatAttachments().render();
    },
    removeUnsupportedPendingImages() {
      activeAttachments()?.removeUnsupportedImages();
    },
    updateComposerSendState() {
      workspace.syncChatDraft();
      activeSubmit()?.updateSendState();
    },
    resizeComposerInput() {
      activeSubmit()?.resize();
    },
    async uploadComposerAttachment(file) {
      if (!workspace.isHome()) {
        await getChatAttachments().upload(file);
        return;
      }
      try {
        await getHomeComposer().upload(file);
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : String(error),
          "failed",
        );
      }
    },
    dispatchComposerMessage(requestedAction = "") {
      if (!workspace.isHome()) {
        getChatSubmit().dispatch(requestedAction);
        return;
      }
      rememberModelSelection();
      getHomeComposer().dispatch();
    },
  };
}
