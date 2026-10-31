import { modelProfileLabels } from "../lib/model-profile-labels.js";
import { escapeAttribute, escapeHtml, textOf } from "../lib/text-format.js";
import { normalizeToolPermissionMode } from "../lib/tool-permission-mode.js";
import { createReasoningModeController } from "./reasoning-mode-controller.js";
import { createToolPermissionModeController } from "./tool-permission-mode-controller.js";

export { normalizeToolPermissionMode } from "../lib/tool-permission-mode.js";

export { normalizeAgentMode } from "./reasoning-mode-controller.js";

export function createRuntimeSelectionController({
  state,
  dom,
  preferences,
  modelSelector,
  client,
  recordControlEvent,
  onAttachmentPolicyChange,
  getComposerSessionId = () => state.currentSessionId,
  onModelCatalogLoading = () => {},
  onModelCatalogLoaded = () => {},
  onModelCatalogUnavailable = () => {},
  onReasoningConfigurationApplied,
}) {
  let modelCatalogEnvironmentId = null;
  let modelCatalogLoadRevision = 0;

  function configuredEnvironmentOptions(config = state.config) {
    const raw = Array.isArray(config?.environments)
      ? config.environments
      : [];
    const options = raw
      .map((entry) => {
        const id = textOf(entry?.id).trim();
        return id
          ? { value: id, label: textOf(entry?.label, id).trim() || id }
          : null;
      })
      .filter(Boolean);
    if (options.length > 0) return options;
    const fallback = textOf(config?.defaultEnvironmentId).trim();
    return fallback ? [{ value: fallback, label: fallback }] : [];
  }

  function renderEnvironmentOptions() {
    const current = dom.environmentSelect.value;
    const options = configuredEnvironmentOptions();
    dom.environmentSelect.innerHTML = "";
    for (const option of options) {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      dom.environmentSelect.append(element);
    }
    if (options.some((option) => option.value === current)) {
      dom.environmentSelect.value = current;
    }
  }

  const selectedEnvironmentId = () =>
    dom.environmentSelect.value ||
    textOf(state.config?.defaultEnvironmentId).trim() ||
    configuredEnvironmentOptions()[0]?.value ||
    "";

  const environmentOptions = () =>
    Array.from(dom.environmentSelect.options).map((option) => ({
      value: option.value,
      label: option.textContent || option.value,
    }));

  function renderAgentPicker() {
    const selected = selectedEnvironmentId();
    const options = environmentOptions();
    const selectedOption =
      options.find((option) => option.value === selected) || options[0];
    const label = selectedOption?.label || selected || "Environment";
    dom.agentPickerButton.hidden = false;
    dom.agentPickerButton.innerHTML = `
      <span class="rail-icon rail-environment-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" /></svg></span>
      <span class="rail-button-label">${escapeHtml(label)}</span>
    `;
    dom.agentPickerButton.title = `Environment: ${label}`;
    dom.agentPickerButton.setAttribute("aria-label", `Environment: ${label}`);
    dom.agentPickerButton.setAttribute(
      "aria-expanded",
      state.agentPickerOpen ? "true" : "false",
    );
    dom.agentPickerButton.classList.toggle("open", state.agentPickerOpen);
    dom.agentPickerMenu.classList.toggle("open", state.agentPickerOpen);
    dom.agentPickerMenu.hidden = !state.agentPickerOpen;
    dom.agentPickerMenu.innerHTML = options
      .map((option) => {
        const active = option.value === selected;
        return `
          <button class="agent-picker-option${active ? " selected" : ""}" type="button"
            role="menuitemradio" aria-checked="${active ? "true" : "false"}"
            tabindex="${active ? "0" : "-1"}" data-environment-id="${escapeAttribute(option.value)}">
            <span>${escapeHtml(option.label)}</span>
          </button>`;
      })
      .join("");
  }

  const selectedModelPreference = () =>
    dom.modelSelect.value ? { profileId: dom.modelSelect.value } : null;
  const selectedModelProfile = (profileId = dom.modelSelect.value) =>
    state.modelProfiles.find(
      (profile) => profile.id === textOf(profileId),
    ) || null;
  function selectedModelSupportsImageInput(profileId = dom.modelSelect.value) {
    const profile = selectedModelProfile(profileId);
    if (typeof profile?.supportsImageInput === "boolean")
      return profile.supportsImageInput;
    const inputModalities = profile?.capabilities?.inputModalities;
    return (
      profile?.provider === "ollama" &&
      Array.isArray(inputModalities) &&
      inputModalities.includes("image")
    );
  }

  function loadPreferences() {
    state.pinnedSessionIds = preferences.loadPinnedSessions();
    state.sessionModes = preferences.loadSessionModes(
      normalizeToolPermissionMode,
    );
    const models = preferences.loadModelPreferences();
    state.sessionModels = models.sessionModels;
    state.lastModelByEnvironment = models.lastModelByEnvironment;
  }

  const saveModelPreferences = () =>
    preferences.saveModelPreferences(
      state.sessionModels,
      state.lastModelByEnvironment,
    );
  const preferredModel = () =>
    textOf(state.sessionModels[getComposerSessionId()]) ||
    textOf(state.lastModelByEnvironment[selectedEnvironmentId()]);

  function applyModelSelection() {
    if (!dom.modelSelect.options.length) {
      modelSelector.sync();
      renderAgentMode();
      return;
    }
    const target =
      preferredModel() ||
      state.defaultModelProfileId ||
      dom.modelSelect.options[0]?.value;
    if (!target) return;
    if (
      [...dom.modelSelect.options].some((option) => option.value === target)
    ) {
      dom.modelSelect.value = target;
    }
    modelSelector.sync();
    renderAgentMode();
  }

  function hasModelCatalogFromAnotherEnvironment() {
    if (modelCatalogEnvironmentId === null) return false;
    return modelCatalogEnvironmentId !== selectedEnvironmentId();
  }

  function rememberModelSelection() {
    if (hasModelCatalogFromAnotherEnvironment()) return;
    const profileId = textOf(dom.modelSelect.value);
    if (!profileId) return;
    state.lastModelByEnvironment[selectedEnvironmentId()] = profileId;
    if (getComposerSessionId())
      state.sessionModels[getComposerSessionId()] = profileId;
    saveModelPreferences();
    renderAgentMode();
  }

  const {
    clearSessionMode, currentToolPermissionMode, initializeSessionMode: initializeToolSessionMode,
    renderPermissionMode, setToolPermissionMode,
  } = createToolPermissionModeController({
    state, dom, preferences, recordControlEvent, getComposerSessionId,
  });

  const { renderAgentMode, loadAgentMode, setAgentMode, selectedReasoningPreference } = createReasoningModeController({
    state, dom, client, selectedEnvironmentId, preferences,
    getScope: () => ({ environmentId: selectedEnvironmentId(), sessionId: getComposerSessionId() }),
    selectedModelProfile: () => hasModelCatalogFromAnotherEnvironment() ? null : selectedModelProfile(),
    reloadModels: onReasoningConfigurationApplied || loadModels, recordControlEvent,
  });

  function initializeSessionMode(sessionId) {
    initializeToolSessionMode(sessionId);
    const environmentId = selectedEnvironmentId();
    const profileId = dom.modelSelect.value;
    if (preferences.loadReasoningPreference?.({ environmentId, sessionId }, profileId)) return;
    const preference = preferences.loadReasoningPreference?.({ environmentId, sessionId: "" }, profileId);
    if (preference) void Promise.resolve(preferences.saveReasoningPreference({ environmentId, sessionId }, profileId, preference)).catch((error) =>
      recordControlEvent({ type: "control", name: "Thinking preference save failed", tone: "failed", summary: error.message }));
  }

  function renderModels() {
    dom.modelSelect.innerHTML = "";
    dom.modelSelect.disabled = state.modelProfiles.length === 0;
    if (state.modelProfiles.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No models configured";
      dom.modelSelect.appendChild(option);
      modelSelector.sync();
      renderAgentMode();
      return;
    }
    const labels = modelProfileLabels(state.modelProfiles);
    for (const profile of state.modelProfiles) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = labels.get(profile.id);
      if (profile.provider === "openai-chatgpt") option.dataset.authentication = "chatgpt";
      dom.modelSelect.appendChild(option);
    }
    if (state.defaultModelProfileId)
      dom.modelSelect.value = state.defaultModelProfileId;
    applyModelSelection();
    onAttachmentPolicyChange();
  }

  async function loadModels() {
    const revision = ++modelCatalogLoadRevision;
    const environmentId = selectedEnvironmentId();
    renderAgentMode();
    onModelCatalogLoading();
    let payload = null;
    try {
      payload = await client.listModels(environmentId);
      if (
        revision !== modelCatalogLoadRevision ||
        environmentId !== selectedEnvironmentId()
      ) {
        return false;
      }
      modelCatalogEnvironmentId = environmentId;
      state.defaultModelProfileId = textOf(payload.defaultProfileId);
      state.modelProfiles = Array.isArray(payload.profiles)
        ? payload.profiles
        : [];
    } catch (error) {
      if (
        revision !== modelCatalogLoadRevision ||
        environmentId !== selectedEnvironmentId()
      ) {
        return false;
      }
      modelCatalogEnvironmentId = environmentId;
      state.defaultModelProfileId = "";
      state.modelProfiles = [];
      renderModels();
      onModelCatalogUnavailable(error);
      return false;
    }
    renderModels();
    onModelCatalogLoaded(payload);
    return true;
  }

  return {
    applyModelSelection,
    clearSessionMode,
    configuredEnvironmentOptions,
    currentToolPermissionMode,
    initializeSessionMode,
    environmentOptions,
    loadAgentMode,
    loadModels,
    loadPreferences,
    rememberModelSelection,
    renderAgentMode,
    renderAgentPicker,
    renderEnvironmentOptions,
    renderModels,
    renderPermissionMode,
    saveModelPreferences,
    selectedEnvironmentId,
    selectedModelPreference,
    selectedReasoningPreference,
    selectedModelSupportsImageInput,
    setAgentMode,
    setToolPermissionMode,
  };
}
