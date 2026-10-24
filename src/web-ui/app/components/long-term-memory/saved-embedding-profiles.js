import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";

export function savedEmbeddingProfiles(status) {
  return Array.isArray(status?.embeddingProfiles) ? status.embeddingProfiles : [];
}

export function selectedEmbeddingProfile(state) {
  return savedEmbeddingProfiles(state.status).find((profile) => profile.id === state.selectedProfileId);
}

export function hasSavedEmbeddingProvider(state, profile) {
  return state.status?.providers?.some((provider) => provider.id === profile.providerId) === true;
}

export function hasUnavailableSelectedEmbeddingProfile(state) {
  const profile = selectedEmbeddingProfile(state);
  if (!profile) return false;
  return !hasSavedEmbeddingProvider(state, profile);
}

export function matchingSelectedEmbeddingProfile(state, providerId, model) {
  const profile = selectedEmbeddingProfile(state);
  if (profile?.providerId !== providerId) return undefined;
  if (profile.model !== model) return undefined;
  return profile;
}

export function isConfiguredEmbeddingProfile(state, profileId) {
  return state.status?.profileId === profileId;
}

function renderProfileCard(state, profile, canRemove) {
  const selected = profile.id === state.selectedProfileId;
  const configured = isConfiguredEmbeddingProfile(state, profile.id);
  const available = hasSavedEmbeddingProvider(state, profile);
  const confirming = state.removingProfileId === profile.id;
  const provider = state.status?.providers?.find((entry) => entry.id === profile.providerId);
  const badge = configured ? '<span class="embedding-profile-badge">Configured for memory</span>' : "";
  const remove = canRemove ? `<button type="button" class="embedding-profile-remove"
    data-memory-remove-profile="${escapeAttribute(profile.id)}"
    aria-label="Remove ${escapeAttribute(profile.label)}"
    ${state.busy || configured ? "disabled" : ""}
    title="${configured ? "Choose another memory profile before removing this one." : "Remove this saved profile"}">Remove</button>` : "";
  const confirmation = confirming ? `<div class="embedding-profile-confirm" role="group" aria-label="Confirm profile removal">
    <p>Remove this saved profile? Stored memories and the connection will stay.</p>
    <button type="button" data-memory-confirm-remove="${escapeAttribute(profile.id)}" ${state.busy ? "disabled" : ""}>Remove profile</button>
    <button type="button" data-memory-cancel-remove ${state.busy ? "disabled" : ""}>Cancel</button>
  </div>` : "";
  return `<article class="embedding-profile-card ${selected ? "selected" : ""}">
    <button type="button" class="embedding-profile-select"
      data-memory-saved-profile="${escapeAttribute(profile.id)}" aria-pressed="${selected}"
      ${state.busy || !available ? "disabled" : ""}>
      <span class="embedding-profile-top"><span class="embedding-profile-provider">${escapeHtml(provider?.type || profile.providerId)}</span>${badge}</span>
      <strong>${escapeHtml(profile.label)}</strong>
      <span class="embedding-profile-model">${escapeHtml(profile.model)}</span>
      <span class="embedding-profile-connection">Connection · ${escapeHtml(profile.providerId)}</span>
      ${!available ? '<span class="embedding-profile-unavailable">Connection unavailable</span>' : ""}
    </button>
    <div class="embedding-profile-footer"><span>${selected ? "Selected" : "Saved profile"}</span>${remove}</div>
    ${confirmation}
  </article>`;
}

export function renderSavedEmbeddingProfiles(state, canRemove) {
  const profiles = savedEmbeddingProfiles(state.status);
  return `<section class="embedding-profiles" aria-label="Saved embedding profiles">
    <div class="embedding-profiles-heading"><div><h5>Embedding profiles</h5>
      <p>Save a model and connection, then select it for memory.</p></div>
      <button type="button" data-memory-new-profile ${state.busy ? "disabled" : ""}>+ New profile</button>
    </div>
    <div class="embedding-profile-grid">${profiles.map((profile) => renderProfileCard(state, profile, canRemove)).join("")}</div>
    ${profiles.length ? "" : '<p class="embedding-profile-empty">No saved profiles yet. Create your first one below.</p>'}
  </section>`;
}

export function bindSavedEmbeddingProfiles({ state, onSelected, onRemove, onChange }) {
  state.root.querySelectorAll("[data-memory-saved-profile]").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.busy) return;
      const profile = savedEmbeddingProfiles(state.status).find((entry) => entry.id === button.dataset.memorySavedProfile);
      if (!profile || !hasSavedEmbeddingProvider(state, profile)) return;
      state.selectedProfileId = profile.id;
      state.profileLabel = profile.label;
      state.removingProfileId = "";
      onSelected();
    });
  });
  state.root.querySelector("[data-memory-new-profile]")?.addEventListener("click", () => {
    if (state.busy) return;
    state.selectedProfileId = "";
    state.profileLabel = "";
    state.removingProfileId = "";
    onSelected();
  });
  state.root.querySelector("[data-memory-profile-label]")?.addEventListener?.("input", (event) => {
    state.profileLabel = event.target.value;
  });
  state.root.querySelectorAll("[data-memory-remove-profile]").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.busy || isConfiguredEmbeddingProfile(state, button.dataset.memoryRemoveProfile)) return;
      state.removingProfileId = button.dataset.memoryRemoveProfile;
      onChange();
    });
  });
  state.root.querySelector("[data-memory-cancel-remove]")?.addEventListener("click", () => {
    if (state.busy) return;
    state.removingProfileId = "";
    onChange();
  });
  const confirm = state.root.querySelector("[data-memory-confirm-remove]");
  confirm?.addEventListener("click", () => {
    void onRemove(confirm.dataset.memoryConfirmRemove);
  });
}
