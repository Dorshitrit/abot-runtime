/** Compare only the controls visible on the selected composer surface. */
export function runControlsPresentationKey({ profileId, agentMode, preference, reasoning, run, configured }) {
  const hasBadge = run && (!run.primaryProfileId || run.primaryProfileId !== profileId);
  const badge = hasBadge ? run : null;
  const recordedModel = configured ? null : run?.primaryModel;
  return JSON.stringify([
    profileId, agentMode, preference?.profileId, preference?.mode, preference?.budgetTokens,
    reasoning?.label, reasoning?.title, reasoning?.budgetLabel, reasoning?.budgetTitle,
    Boolean(badge), badge?.primaryProfileId, badge?.primaryModel?.label, badge?.status,
    recordedModel?.label, recordedModel?.provider,
  ]);
}

/** Missing catalog entries retain their recorded identity without becoming sendable. */
export function ensureRecordedModelOption(select, run, profileId) {
  for (const option of [...select.options]) {
    if (option.dataset?.recordedRun !== "true") continue;
    if (option.value === profileId) continue;
    option.remove?.();
  }
  if (!run?.primaryProfileId || run.primaryProfileId !== profileId) return;
  if ([...select.options].some((option) => option.value === profileId)) return;
  const option = (select.ownerDocument || document).createElement("option");
  option.value = profileId;
  option.textContent = `${run.primaryModel?.label || profileId} (unavailable)`;
  option.disabled = true;
  option.dataset.recordedRun = "true";
  option.dataset.providerLabel = run.primaryModel?.provider || "";
  select.appendChild(option);
}

export function renderRunSelectionBadge(button, run, selectedProfileId) {
  if (!button?.ownerDocument) return;
  let badge = button.querySelector("[data-session-run-model]");
  const differs = run?.primaryProfileId && run.primaryProfileId !== selectedProfileId;
  const unknown = run && !run.primaryProfileId;
  if (!differs && !unknown) { badge?.remove(); return; }
  if (!badge) {
    badge = button.ownerDocument.createElement("span");
    badge.dataset.sessionRunModel = "true";
    badge.className = "model-select-route";
    button.appendChild(badge);
  }
  const active = run.status === "streaming" || run.status === "awaiting_approval";
  const stateLabel = active ? "Running" : "Last run";
  badge.textContent = unknown ? "Run model unavailable" : `${stateLabel}: ${run.primaryModel?.label || run.primaryProfileId}`;
  badge.title = unknown ? "The previous run's model was not recorded." : "Recorded run model";
}
