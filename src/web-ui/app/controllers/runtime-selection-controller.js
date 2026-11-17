import { modelSelectorOptions } from "../lib/model-selector-options.js";
import { escapeAttribute, escapeHtml, textOf } from "../lib/text-format.js";
import { normalizeToolPermissionMode } from "../lib/tool-permission-mode.js";
import { createReasoningModeController } from "./reasoning-mode-controller.js";
import { createToolPermissionModeController } from "./tool-permission-mode-controller.js";
import { createSessionRunSelection } from "./session-run-selection.js";
import { ensureRecordedModelOption, renderRunSelectionBadge, runControlsPresentationKey } from "./session-run-selection-presentation.js";
import { sessionRunReasoningDisplay } from "./session-run-reasoning.js";

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
  getComposerIsHome = () => false,
  hasUnsentDraft = () => true,
  getSubmissionScopes = () => [],
  onModelCatalogLoading = () => {},
  onModelCatalogLoaded = () => {},
  onModelCatalogUnavailable = () => {},
  onReasoningConfigurationApplied,
}) {
  let modelCatalogEnvironmentId = null;
  let modelCatalogLoadRevision = 0;
  let renderedRunControlsKey;

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

  const runSelection = createSessionRunSelection({
    getScope: () => ({ environmentId: selectedEnvironmentId(), sessionId: state.currentSessionId, viewVersion: state.sessionViewVersion }),
    getComposerScope: () => ({ environmentId: selectedEnvironmentId(), sessionId: getComposerSessionId() }),
    isHome: getComposerIsHome,
    getRequestGeneration: (requestId) => state.requestLifecycles?.get(requestId)?.generation,
    hasUnsentDraft,
    getSubmissionScopes,
  });
  function selectedModelPreference() {
    const profileId = dom.modelSelect.value;
    const recorded = [...dom.modelSelect.options].find((option) => option.value === profileId);
    if (recorded?.dataset?.recordedRun === "true") throw new Error("This run's model is no longer available. Select an available model.");
    return profileId ? { profileId } : null;
  }
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
  const preferredModel = () => textOf(state.lastModelByEnvironment[selectedEnvironmentId()]);
  const fallbackModel = () => {
    if (getComposerIsHome()) return preferredModel();
    return textOf(state.sessionModels[getComposerSessionId()]) || preferredModel();
  };

  function clearStaleModelExecutionPolicies() {
    if (!hasModelCatalogFromAnotherEnvironment()) return;
    for (const option of dom.modelSelect.options) delete option.dataset.executionPolicy;
  }

  function syncModelSelector() {
    clearStaleModelExecutionPolicies();
    modelSelector.sync();
    renderRunSelectionBadge(dom.modelSelectButton, runSelection.run(), dom.modelSelect.value);
    renderedRunControlsKey = currentRunControlsKey();
  }

  function applyModelSelection({ notifyAttachmentPolicy = true } = {}) {
    const previousProfileId = dom.modelSelect.value;
    const target = runSelection.selectedProfileId(fallbackModel()) ||
      state.defaultModelProfileId || dom.modelSelect.options[0]?.value;
    ensureRecordedModelOption(dom.modelSelect, runSelection.run(), target);
    if (!target) return;
    if (
      [...dom.modelSelect.options].some((option) => option.value === target)
    ) {
      dom.modelSelect.value = target;
    }
    syncModelSelector();
    renderAgentMode();
    if (notifyAttachmentPolicy && previousProfileId !== dom.modelSelect.value) onAttachmentPolicyChange();
  }

  function hasModelCatalogFromAnotherEnvironment() {
    if (modelCatalogEnvironmentId === null) return false;
    return modelCatalogEnvironmentId !== selectedEnvironmentId();
  }

  function rememberModelSelection({ explicit = false } = {}) {
    if (hasModelCatalogFromAnotherEnvironment()) return;
    const profileId = textOf(dom.modelSelect.value);
    if (!profileId) return;
    if (!explicit) {
      if (getComposerIsHome()) state.sessionModels[getComposerSessionId()] = profileId;
      return;
    }
    runSelection.remember({ profileId });
    state.lastModelByEnvironment[selectedEnvironmentId()] = profileId;
    if (getComposerSessionId())
      state.sessionModels[getComposerSessionId()] = profileId;
    saveModelPreferences();
    syncModelSelector();
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
    getSelectedAgentMode: () => runSelection.selectedAgentMode(state.agentMode),
    getRunReasoningDisplay: () => sessionRunReasoningDisplay(runSelection.reasoningRun(dom.modelSelect.value)),
    getSelectedReasoningPreference: (fallback) => runSelection.selectedReasoningPreference(dom.modelSelect.value, fallback),
    onAgentModeSelected: (agentMode) => { runSelection.remember({ agentMode }); renderedRunControlsKey = currentRunControlsKey(); },
    onReasoningPreferenceSelected: (reasoningPreference) => { runSelection.remember({ reasoningPreference }); renderedRunControlsKey = currentRunControlsKey(); },
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
      applyModelSelection({ notifyAttachmentPolicy: false });
      onAttachmentPolicyChange();
      return;
    }
    for (const model of modelSelectorOptions(state.modelProfiles)) {
      const option = document.createElement("option");
      option.value = model.value;
      option.textContent = model.label;
      option.dataset.providerId = model.providerId;
      option.dataset.providerLabel = model.providerLabel;
      if (model.executionPolicy) option.dataset.executionPolicy = model.executionPolicy;
      if (model.usingChatgptPlan) option.dataset.authentication = "chatgpt";
      dom.modelSelect.appendChild(option);
    }
    if (state.defaultModelProfileId)
      dom.modelSelect.value = state.defaultModelProfileId;
    applyModelSelection({ notifyAttachmentPolicy: false });
    onAttachmentPolicyChange();
  }

  async function loadModels() {
    const revision = ++modelCatalogLoadRevision;
    const environmentId = selectedEnvironmentId();
    syncModelSelector();
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

  function currentRunControlsKey() {
    const profileId = runSelection.selectedProfileId(fallbackModel()) || state.defaultModelProfileId || dom.modelSelect.options[0]?.value;
    const scope = { environmentId: selectedEnvironmentId(), sessionId: getComposerSessionId() };
    return runControlsPresentationKey({
      profileId, agentMode: runSelection.selectedAgentMode(state.agentMode),
      preference: runSelection.selectedReasoningPreference(profileId, preferences.loadReasoningPreference?.(scope, profileId)),
      reasoning: sessionRunReasoningDisplay(runSelection.reasoningRun(profileId)),
      run: runSelection.run(), configured: Boolean(selectedModelProfile(profileId)),
    });
  }
  function applySessionSnapshot(payload, scope) {
    if (!runSelection.applySnapshot(payload, scope)) return false;
    if (renderedRunControlsKey === currentRunControlsKey()) return false;
    applyModelSelection();
    return true;
  }
  function observeRunEvent(message) {
    if (!runSelection.observeEvent(message)) return false;
    if (renderedRunControlsKey === currentRunControlsKey()) return false;
    applyModelSelection();
    return true;
  }
  function pruneEmptyDraftSelections(scope) {
    if (!runSelection.pruneEmptyDraftSelections(scope)) return false;
    if (renderedRunControlsKey === currentRunControlsKey()) return false;
    applyModelSelection();
    return true;
  }
  return {
    applyModelSelection,
    applySessionSnapshot, observeRunEvent,
    pruneEmptyDraftSelections,
    retireSessionSelection: runSelection.retireSessionSelection,
    clearRunSelection: () => { runSelection.pruneEmptyDraftSelections(); runSelection.clear(); applyModelSelection(); },
    selectedAgentMode: () => runSelection.selectedAgentMode(state.agentMode),
    modelProfileIdForSession: (sessionId) => runSelection.profileIdForSession(
      { environmentId: selectedEnvironmentId(), sessionId },
      textOf(state.sessionModels[sessionId]) || preferredModel() || state.defaultModelProfileId),
    clearSessionMode,
    configuredEnvironmentOptions,
    currentToolPermissionMode,
    initializeSessionMode,
    environmentOptions,
    loadAgentMode,
    loadModels,
    loadPreferences,
    rememberModelSelection,
    renderAgentMode: () => { renderAgentMode(); renderedRunControlsKey = currentRunControlsKey(); },
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
