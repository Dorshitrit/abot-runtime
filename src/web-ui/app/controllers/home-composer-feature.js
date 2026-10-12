/** Home is another surface of the shared composer, with navigation before POST. */
export function createHomeComposerFeature({ workspace, composer, selectedModelSupportsImageInput, activateHomeSession }) {
  const surface = composer.createSurface({
    surfaceDom: workspace.homeDom, currentDraft: workspace.homeView.current,
    ensureDraftSession: workspace.ensureHomeSession, visible: workspace.isHome,
    supportsImages: selectedModelSupportsImageInput, allowsActiveRequest: false,
    async prepareSend(payload) {
      const activated = await activateHomeSession(payload.scope);
      if (!activated) return false;
      workspace.finishHomeActivation(payload.scope);
      return true;
    },
  });
  function render() { workspace.syncChatDraft(); surface.render(); }
  return {
    ...surface, render,
    setWorkspace(destination) { workspace.setWorkspace(destination); render(); },
    environmentChanged: render,
    dispatch: () => surface.submit.dispatch("send"),
    upload: surface.attachments.upload,
  };
}
