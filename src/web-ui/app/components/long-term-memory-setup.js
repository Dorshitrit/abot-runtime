import {
  bindSavedEmbeddingProfiles,
  matchingSelectedEmbeddingProfile,
  hasUnavailableSelectedEmbeddingProfile,
  isConfiguredEmbeddingProfile,
  savedEmbeddingProfiles,
  selectedEmbeddingProfile,
} from "./long-term-memory/saved-embedding-profiles.js";
import { renderMemorySetup } from "./long-term-memory/setup-rendering.js";
import { textOf } from "../lib/text-format.js";

export function createLongTermMemorySetup({
  getEnvironmentId = () => "",
  loadStatus,
  discoverModels,
  enableMemory,
  saveProfile,
  removeProfile,
  disableMemory,
  recordControlEvent,
  beginRuntimeMutation = () => true,
  refreshRuntimeConfig = async () => true,
  endRuntimeMutation = () => {},
  onAddConnection,
  onEnvironmentChanged = () => {},
}) {
  const state = {
    root: null,
    status: null,
    selectedProfileId: "",
    removingProfileId: "",
    profileLabel: "",
    models: [],
    discoverySupported: false,
    busy: "",
    message: "",
    error: "",
    loadRevision: 0,
    actionRevision: 0,
    environmentId: "",
  };

  function mount(root) {
    state.root = root;
    render();
  }

  async function load(options = {}) {
    const revision = ++state.loadRevision;
    state.actionRevision += 1;
    const environmentId = getEnvironmentId();
    const environmentChanged = state.environmentId !== environmentId;
    if (environmentChanged) {
      onEnvironmentChanged();
      state.environmentId = environmentId;
      state.status = null;
      state.selectedProfileId = "";
      state.removingProfileId = "";
      state.profileLabel = "";
      state.models = [];
      state.discoverySupported = false;
    }
    state.busy = "status";
    clearFeedback();
    const preserveInputs = !environmentChanged && options.preserveInputs !== false;
    render({ preserveInputs });
    try {
      const payload = await loadStatus(environmentId);
      if (
        revision !== state.loadRevision ||
        environmentId !== getEnvironmentId()
      ) {
        return false;
      }
      const hadStatus = Boolean(state.status);
      state.status = payload.status || null;
      if (!preserveInputs || !hadStatus) {
        state.selectedProfileId = state.status?.profileId || "";
        state.profileLabel = selectedEmbeddingProfile(state)?.label || "";
      }
      return true;
    } catch (error) {
      if (
        revision !== state.loadRevision ||
        environmentId !== getEnvironmentId()
      ) {
        return false;
      }
      state.error = errorMessage(error);
      return false;
    } finally {
      if (
        revision === state.loadRevision &&
        environmentId === getEnvironmentId()
      ) {
        state.busy = "";
        render({ preserveInputs });
      }
    }
  }

  async function discover() {
    const providerId = selectedProviderId();
    if (!providerId) {
      showError("Choose a configured provider first.");
      return;
    }
    await runAction(
      "discover",
      (environmentId) => discoverModels(providerId, environmentId),
      (payload) => {
        state.models = Array.isArray(payload.catalog?.models)
          ? payload.catalog.models
          : [];
        state.discoverySupported = payload.catalog?.supported === true;
        state.message = discoveryMessage();
      },
    );
  }

  async function enable() {
    if (state.busy) return;
    if (saveProfile && !selectedEmbeddingProfile(state)) {
      showError("Save the profile before testing and enabling memory.");
      return;
    }
    if (hasUnavailableSelectedEmbeddingProfile(state)) {
      showError("This saved profile's provider is unavailable. Choose an available profile or connection.");
      return;
    }
    const providerId = selectedProviderId();
    const model = textOf(
      state.root?.querySelector("[data-memory-model]")?.value,
    ).trim();
    if (!providerId || !model) {
      showError("Choose a provider and enter an embedding model ID.");
      return;
    }
    const emitClientEvents =
      state.root?.querySelector("[data-memory-events]")?.checked === true;
    await runRuntimeMutation(
      "enable",
      (environmentId) =>
        enableMemory(
          {
            providerId,
            model,
            emitClientEvents,
            ...(matchingSelectedEmbeddingProfile(state, providerId, model)
              ? { profileId: state.selectedProfileId }
              : {}),
          },
          environmentId,
        ),
      (payload) => {
        state.status = payload.status || null;
        state.selectedProfileId = state.status?.profileId || state.selectedProfileId;
        state.message =
          "Connection test passed. Memory configuration saved. Apply the configuration to use it.";
        recordResult("Long-term memory enabled", payload);
      },
    );
  }

  async function saveEmbeddingProfile() {
    if (!saveProfile || state.busy || selectedEmbeddingProfile(state)) return;
    if (hasUnavailableSelectedEmbeddingProfile(state)) {
      showError("This saved profile's provider is unavailable. Choose an available profile or connection.");
      return;
    }
    const providerId = selectedProviderId();
    const model = currentModelValue();
    const label = state.profileLabel.trim();
    if (!providerId || !model || !label) {
      showError("Choose a provider, enter a model ID and give the profile a name.");
      return;
    }
    await runRuntimeMutation(
      "save-profile",
      (environmentId) => saveProfile({ providerId, model, label }, environmentId),
      (payload) => {
        state.status = payload.status || null;
        state.selectedProfileId = payload.profileId || "";
        state.profileLabel = selectedEmbeddingProfile(state)?.label || label;
        state.message = "Embedding profile saved. The active memory configuration has not changed.";
        recordControlEvent({
          type: "control", name: "Embedding profile saved", tone: "done", summary: label,
        });
      },
    );
  }

  async function disable() {
    await runRuntimeMutation(
      "disable",
      (environmentId) => disableMemory(environmentId),
      (payload) => {
        state.status = payload.status || null;
        state.message = "Memory is disabled; restart ABot to apply it.";
        recordResult("Long-term memory disabled", payload);
      },
    );
  }

  async function addConnection() {
    if (state.busy || !onAddConnection) return;
    try {
      await onAddConnection({
        emitClientEvents:
          state.root?.querySelector("[data-memory-events]")?.checked === true,
        ...(state.status?.profileId ? { profileId: state.status.profileId } : {}),
      });
    } catch {
      showError("Embedding connection setup could not be opened. Try again.");
    }
  }

  async function runRuntimeMutation(name, request, applyResult) {
    if (!beginRuntimeMutation()) {
      showError(
        "Save or reset configuration changes before changing memory settings.",
      );
      return false;
    }
    try {
      return await runAction(name, request, async (payload) => {
        applyResult(payload);
        await refreshRuntimeConfig();
      });
    } finally {
      endRuntimeMutation();
    }
  }

  async function runAction(name, request, applyResult) {
    const revision = ++state.actionRevision;
    const environmentId = getEnvironmentId();
    state.loadRevision += 1;
    state.busy = name;
    clearFeedback();
    render();
    try {
      const payload = await request(environmentId);
      if (
        revision !== state.actionRevision ||
        environmentId !== getEnvironmentId()
      ) {
        return false;
      }
      await applyResult(payload);
      return true;
    } catch (error) {
      if (
        revision !== state.actionRevision ||
        environmentId !== getEnvironmentId()
      ) {
        return false;
      }
      state.error = errorMessage(error);
      recordControlEvent({
        type: "control",
        name: "Long-term memory setup failed",
        tone: "failed",
        summary: state.error,
      });
      return false;
    } finally {
      if (
        revision === state.actionRevision &&
        environmentId === getEnvironmentId()
      ) {
        state.busy = "";
        render();
      }
    }
  }

  function render(options = {}) {
    if (!state.root) return;
    const status = state.status || {};
    const profile = selectedEmbeddingProfile(state);
    const preserveInputs = options.preserveInputs !== false;
    const defaultProvider = profile?.providerId || status.providerId || status.providers?.[0]?.id || "";
    const defaultModel = profile?.model || (saveProfile ? "" : status.model || "");
    const selectedProvider = preserveInputs && !profile
      ? state.root.querySelector("[data-memory-provider]")?.value ?? defaultProvider
      : defaultProvider;
    const selectedModel = preserveInputs && !profile
      ? state.root.querySelector("[data-memory-model]")?.value ?? defaultModel
      : defaultModel;
    const emitClientEvents = preserveInputs
      ? state.root.querySelector("[data-memory-events]")?.checked ?? status.emitClientEvents === true
      : status.emitClientEvents === true;
    state.root.innerHTML = renderMemorySetup({
      state, selectedProvider, selectedModel, emitClientEvents,
      canSave: Boolean(saveProfile), canRemove: Boolean(removeProfile),
      canAddConnection: Boolean(onAddConnection),
    });
    bindSavedEmbeddingProfiles({
      state,
      onSelected: () => {
        state.models = [];
        clearFeedback();
        render({ preserveInputs: false });
      },
      onChange: render,
      onRemove: removeEmbeddingProfile,
    });
    bindActions();
  }

  async function removeEmbeddingProfile(profileId) {
    if (!removeProfile || state.busy) return;
    if (isConfiguredEmbeddingProfile(state, profileId)) {
      showError("Choose another memory profile before removing this one.");
      return;
    }
    const profile = savedEmbeddingProfiles(state.status).find((entry) => entry.id === profileId);
    if (!profile || state.removingProfileId !== profileId) return;
    await runRuntimeMutation(
      "remove-profile",
      (environmentId) => removeProfile({ profileId }, environmentId),
      (payload) => {
        state.status = payload.status || null;
        state.removingProfileId = "";
        if (state.selectedProfileId === profileId) {
          state.selectedProfileId = state.status?.profileId || "";
          state.profileLabel = selectedEmbeddingProfile(state)?.label || "";
          render({ preserveInputs: false });
        }
        state.message = "Profile removed. Stored memories and connections are unchanged.";
        recordControlEvent({
          type: "control", name: "Embedding profile removed", tone: "done", summary: profile.label,
        });
      },
    );
  }

  function bindActions() {
    state.root.querySelectorAll("[data-memory-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.memoryAction;
        if (action === "discover") void discover();
        else if (action === "enable") void enable();
        else if (action === "save-profile") void saveEmbeddingProfile();
        else if (action === "disable") void disable();
        else if (action === "add-connection") void addConnection();
      });
    });
  }

  function selectedProviderId() {
    return textOf(
      state.root?.querySelector("[data-memory-provider]")?.value,
    ).trim();
  }

  function currentModelValue() {
    return textOf(
      state.root?.querySelector("[data-memory-model]")?.value,
    ).trim();
  }

  function clearFeedback() {
    state.message = "";
    state.error = "";
  }

  function showError(message) {
    state.error = message;
    render();
  }

  function discoveryMessage() {
    if (!state.discoverySupported) {
      return "This provider does not expose model discovery. Enter its embedding model ID manually.";
    }
    return state.models.length
      ? `Found ${state.models.length} installed model${state.models.length === 1 ? "" : "s"}. Embedding support is not verified.`
      : "The provider returned no installed models.";
  }

  function recordResult(name, payload) {
    recordControlEvent({
      type: "control",
      name,
      tone: "done",
      summary: payload.backupPath
        ? `backup: ${payload.backupPath}`
        : "restart required",
    });
  }

  return { load, mount };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
