export function automationAuthoringStarter(automationId = "", revision = 0) {
  const draftOnlyScope = "Design the future workflow; do not carry out its steps now. Leave permission grants, publication and execution to me.";
  const hasExactDraftRevision = automationId && Number.isInteger(revision) && revision > 0;
  if (hasExactDraftRevision)
    return `Help me refine ABot Studio automation ${automationId} (draft revision ${revision}). ${draftOnlyScope} Read this exact draft first, then save the related changes together, including the connections between steps. I want to change: `;
  return `Help me build an automation in ABot Studio. ${draftOnlyScope} Save the complete draft with its steps connected. I want it to: `;
}

/** Opens a normal editable chat; the visible message is the only draft association. */
export function openAutomationAuthoringChat({
  dom, shell, automationId = "", revision = 0,
  confirmReplace = (message) => globalThis.confirm(message),
}) {
  const composer = dom.composerInput;
  if (!composer || !dom.newSessionButton) return false;
  if (composer.value.trim() && !confirmReplace("Replace your unsent chat message with an automation starter?"))
    return false;
  dom.newSessionButton.click();
  if (shell.activeWorkspace() !== "chat") return false;
  composer.value = automationAuthoringStarter(automationId, revision);
  const EventType = composer.ownerDocument?.defaultView?.Event || globalThis.Event;
  composer.dispatchEvent(new EventType("input", { bubbles: true }));
  composer.focus();
  return true;
}
