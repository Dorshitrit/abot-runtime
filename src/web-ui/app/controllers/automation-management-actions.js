/** Management writes and their follow-up reads belong to the initiating view. */
export function createAutomationManagementActions({ state, client, mutation,
  captureView, loadList, loadSelected, refresh, openRoute }) {
  async function create(templateId = "") {
    const view = captureView();
    const label = templateId ? "Template" : "Draft";
    const result = await mutation(label, () => client.createAutomation(
      view.environmentId, templateId || undefined), `${label} saved.`, view.isCurrent);
    if (!result?.draft?.automationId || !view.isCurrent()) return false;
    const continuation = view.captureContinuation();
    const refreshed = await loadList(continuation.isCurrent);
    if (!refreshed || !continuation.isCurrent()) return false;
    return openRoute(result.draft.automationId, "", continuation.ownsMutation);
  }

  async function deleteDraft() {
    const view = captureView();
    const revision = state.draft?.revision;
    if (!view.automationId || !Number.isInteger(revision) || state.publishedDefinition) return false;
    const result = await mutation("Draft deletion", () => client.deleteAutomationDraft(
      view.automationId, revision, view.environmentId), "Draft deleted.", view.isCurrent);
    if (!result?.ok || !view.isCurrent()) return false;
    const continuation = view.captureContinuation();
    state.automations = state.automations.filter((item) => item.id !== view.automationId);
    const refreshed = await loadList(continuation.isCurrent);
    if (!refreshed || !continuation.isCurrent()) return false;
    return openRoute("", "", continuation.ownsMutation);
  }

  async function publishDefinition() {
    const view = captureView();
    const expectedRevision = state.draft?.revision;
    if (!view.automationId || !Number.isInteger(expectedRevision)) return false;
    const response = await mutation("Publication", () => client.publishAutomation(
      view.automationId, expectedRevision, view.environmentId), "Publication saved.", view.isCurrent);
    if (!response || !view.isCurrent()) return false;
    return refresh(view.captureContinuation().isCurrent);
  }

  async function setActive(activeValue) {
    const view = captureView();
    if (!view.automationId) return false;
    const label = activeValue ? "Activation" : "Pause";
    const response = await mutation(label, () => client.setAutomationActive(
      view.automationId, activeValue, view.environmentId), `${label} saved.`, view.isCurrent);
    if (!response || !view.isCurrent()) return false;
    return refresh(view.captureContinuation().isCurrent);
  }

  async function changeArchiveState(archive) {
    const view = captureView();
    const expectedRevision = state.draft?.revision;
    const selected = state.automations.find((item) => item.id === view.automationId);
    const canChangeArchiveState = archive ? selected?.status !== "archived" : selected?.status === "archived";
    if (!Number.isInteger(expectedRevision) || !selected?.publishedRevision || !canChangeArchiveState) return false;
    const label = archive ? "Archive" : "Restore";
    const response = await mutation(label, () => archive
      ? client.archiveAutomation(view.automationId, expectedRevision, view.environmentId)
      : client.restoreAutomation(view.automationId, expectedRevision, view.environmentId), `${label} saved.`, view.isCurrent);
    if (!response || !view.isCurrent()) return false;
    return refresh(view.captureContinuation().isCurrent);
  }

  async function setPermission(mode, operations) {
    const view = captureView();
    if (!view.automationId) return false;
    const input = { expectedGrantRevision: state.grant?.grantRevision || 0, mode, operations };
    const response = await mutation("Permission", () => client.setAutomationPermission(
      view.automationId, input, view.environmentId), "Permission saved.", view.isCurrent);
    if (!response || !view.isCurrent()) return false;
    return loadSelected(view.automationId, view.runId, view.captureContinuation().isCurrent);
  }

  return { create, deleteDraft, publishDefinition, setActive, changeArchiveState, setPermission };
}
