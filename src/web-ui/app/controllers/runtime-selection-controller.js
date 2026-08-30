import { escapeAttribute, escapeHtml, textOf } from "../lib/text-format.js";

export function normalizeAgentMode(mode) {
  const normalized = textOf(mode).trim().toLowerCase();
  return ["fast", "reasoning", "deep", "auto"].includes(normalized)
    ? normalized
    : "reasoning";
}

export function normalizeToolPermissionMode(value) {
  const mode = textOf(value).trim().toLowerCase();
  return mode === "ask" || mode === "approval_required" ? "ask" : "full_access";
}

function agentModeMeta(mode) {
  const modes = {
    auto: { label: "Auto", description: "Lets the agent choose", icon: "*" },
    fast: { label: "Fast", description: "Shorter and quicker", icon: "!" },
    deep: {
      label: "Deep analysis",
      description: "More careful responses",
      icon: "D",
    },
    reasoning: {
      label: "Reasoning",
      description: "Balanced speed and thinking",
      icon: "R",
    },
  };
  return modes[normalizeAgentMode(mode)] || modes.reasoning;
}

function permissionMeta(mode) {
  return normalizeToolPermissionMode(mode) === "ask"
    ? {
        label: "Ask",
        description: "Require approval",
        title: "Ask before running tools",
      }
    : {
        label: "Full",
        description: "Run tools directly",
        title: "Run tools without approval prompts",
      };
}

export function createRuntimeSelectionController({
  state,
  dom,
  preferences,
  modelSelector,
  client,
  recordControlEvent,
  onAttachmentPolicyChange,
  onModelCatalogLoading = () => {},
  onModelCatalogLoaded = () => {},
  onModelCatalogUnavailable = () => {},
}) {
  let agentModeLoadRevision = 0;
  const agentModeMutationRevisions = new Map();
  let agentModeMutationInFlight = false;
  let modelCatalogLoadRevision = 0;

  const agentModeMutationRevisionFor = (environmentId) =>
    agentModeMutationRevisions.get(environmentId) || 0;

  function configuredEnvironmentOptions() {
    const raw = Array.isArray(state.config?.environments)
      ? state.config.environments
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
    const fallback = textOf(state.config?.defaultEnvironmentId).trim();
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
    const glyph = label.slice(0, 3).toLocaleUpperCase();
    dom.agentPickerButton.hidden = false;
    dom.agentPickerButton.innerHTML = `
      <span class="rail-environment-glyph" aria-hidden="true">${escapeHtml(glyph)}</span>
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
  const selectedModelProfile = () =>
    state.modelProfiles.find(
      (profile) => profile.id === textOf(dom.modelSelect.value),
    ) || null;
  function selectedModelSupportsImageInput() {
    const profile = selectedModelProfile();
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
    textOf(state.sessionModels[state.currentSessionId]) ||
    textOf(state.lastModelByEnvironment[selectedEnvironmentId()]);

  function applyModelSelection() {
    if (!dom.modelSelect.options.length) {
      modelSelector.sync();
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
  }

  function rememberModelSelection() {
    const profileId = textOf(dom.modelSelect.value);
    if (!profileId) return;
    state.lastModelByEnvironment[selectedEnvironmentId()] = profileId;
    if (state.currentSessionId)
      state.sessionModels[state.currentSessionId] = profileId;
    saveModelPreferences();
  }

  const sessionModeFor = (sessionId) => {
    const mode = state.sessionModes[sessionId];
    return mode && typeof mode === "object" && !Array.isArray(mode) ? mode : {};
  };
  const currentToolPermissionMode = () =>
    normalizeToolPermissionMode(
      state.currentSessionId
        ? sessionModeFor(state.currentSessionId).toolPermissionMode
        : undefined,
    );

  function clearSessionMode(sessionId) {
    if (!sessionId) return;
    delete state.sessionModes[sessionId];
    preferences.saveSessionModes(state.sessionModes);
  }

  function setToolPermissionMode(mode) {
    if (!state.currentSessionId) return;
    const normalized = normalizeToolPermissionMode(mode);
    if (normalized === "full_access")
      delete state.sessionModes[state.currentSessionId];
    else {
      state.sessionModes[state.currentSessionId] = {
        ...sessionModeFor(state.currentSessionId),
        toolPermissionMode: normalized,
        savedAt: Date.now(),
      };
    }
    preferences.saveSessionModes(state.sessionModes);
    state.permissionModeMenuOpen = false;
    renderPermissionMode();
    dom.permissionModeButton.focus();
  }

  function renderPermissionMode() {
    const mode = currentToolPermissionMode();
    const meta = permissionMeta(mode);
    dom.permissionModeButton.innerHTML = `<span class="permission-mode-label">${escapeHtml(meta.label)}</span>`;
    dom.permissionModeButton.title = meta.title;
    dom.permissionModeButton.disabled = !state.currentSessionId;
    dom.permissionModeButton.classList.toggle("full", mode === "full_access");
    dom.permissionModeButton.classList.toggle(
      "open",
      state.permissionModeMenuOpen,
    );
    dom.permissionModeButton.setAttribute(
      "aria-expanded",
      state.permissionModeMenuOpen ? "true" : "false",
    );
    dom.permissionModeMenu.classList.toggle(
      "open",
      state.permissionModeMenuOpen,
    );
    dom.permissionModeMenu.hidden = !state.permissionModeMenuOpen;
    dom.permissionModeMenu.setAttribute("role", "menu");
    dom.permissionModeMenu.innerHTML = ["full_access", "ask"]
      .map((itemMode) => {
        const item = permissionMeta(itemMode);
        const selected = normalizeToolPermissionMode(itemMode) === mode;
        return `
          <button class="permission-mode-option ${selected ? "selected" : ""}" type="button"
            role="menuitemradio" aria-checked="${selected ? "true" : "false"}"
            tabindex="${selected ? "0" : "-1"}" data-mode="${escapeAttribute(itemMode)}">
            <strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.description)}</small>
          </button>`;
      })
      .join("");
    dom.permissionModeMenu
      .querySelectorAll(".permission-mode-option")
      .forEach((button) => {
        button.addEventListener("click", () =>
          setToolPermissionMode(button.dataset.mode),
        );
      });
  }

  function renderAgentMode() {
    const meta = agentModeMeta(state.agentMode);
    dom.agentModeButton.disabled = agentModeMutationInFlight;
    dom.agentModeButton.innerHTML = `
      <span class="agent-mode-icon">${escapeHtml(meta.icon)}</span>
      <span>${escapeHtml(meta.label)}</span>`;
    dom.agentModeButton.classList.toggle("open", state.agentModeMenuOpen);
    dom.agentModeButton.setAttribute(
      "aria-expanded",
      state.agentModeMenuOpen ? "true" : "false",
    );
    dom.agentModeMenu.classList.toggle("open", state.agentModeMenuOpen);
    dom.agentModeMenu.hidden = !state.agentModeMenuOpen;
    dom.agentModeMenu.setAttribute("role", "menu");
    dom.agentModeMenu.innerHTML = state.supportedAgentModes
      .map((mode) => {
        const item = agentModeMeta(mode);
        const selected = normalizeAgentMode(mode) === state.agentMode;
        return `
          <button class="agent-mode-option ${selected ? "selected" : ""}" type="button"
            role="menuitemradio" aria-checked="${selected ? "true" : "false"}"
            tabindex="${selected ? "0" : "-1"}" data-mode="${escapeAttribute(mode)}" ${agentModeMutationInFlight ? "disabled" : ""}>
            <span class="agent-mode-option-icon">${escapeHtml(item.icon)}</span>
            <span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.description)}</small></span>
          </button>`;
      })
      .join("");
    dom.agentModeMenu
      .querySelectorAll(".agent-mode-option")
      .forEach((button) => {
        button.addEventListener(
          "click",
          () => void setAgentMode(button.dataset.mode),
        );
      });
  }

  async function loadAgentMode() {
    const revision = ++agentModeLoadRevision;
    const environmentId = selectedEnvironmentId();
    const mutationRevision = agentModeMutationRevisionFor(environmentId);
    renderAgentMode();
    try {
      const payload = await client.getAgentMode(environmentId);
      if (
        revision !== agentModeLoadRevision ||
        mutationRevision !== agentModeMutationRevisionFor(environmentId) ||
        environmentId !== selectedEnvironmentId()
      ) {
        return false;
      }
      state.agentMode = normalizeAgentMode(payload.mode);
      state.supportedAgentModes = Array.isArray(payload.supportedModes)
        ? payload.supportedModes.map(normalizeAgentMode)
        : state.supportedAgentModes;
      renderAgentMode();
      return true;
    } catch {
      if (
        revision !== agentModeLoadRevision ||
        mutationRevision !== agentModeMutationRevisionFor(environmentId) ||
        environmentId !== selectedEnvironmentId()
      ) {
        return false;
      }
      state.agentMode = "reasoning";
      renderAgentMode();
      return false;
    }
  }

  async function setAgentMode(mode) {
    if (agentModeMutationInFlight) return false;
    agentModeMutationInFlight = true;
    const environmentId = selectedEnvironmentId();
    const revision = agentModeMutationRevisionFor(environmentId) + 1;
    agentModeMutationRevisions.set(environmentId, revision);
    const loadRevisionAtStart = ++agentModeLoadRevision;
    const previousMode = state.agentMode;
    const requestedMode = normalizeAgentMode(mode);
    state.agentMode = requestedMode;
    state.agentModeMenuOpen = false;
    renderAgentMode();
    dom.agentModeButton.focus();
    try {
      const payload = await client.setAgentMode(requestedMode, environmentId);
      if (
        revision !== agentModeMutationRevisionFor(environmentId) ||
        environmentId !== selectedEnvironmentId()
      ) {
        return false;
      }
      agentModeLoadRevision += 1;
      state.agentMode = normalizeAgentMode(payload.mode);
      renderAgentMode();
      return true;
    } catch (error) {
      if (
        revision !== agentModeMutationRevisionFor(environmentId) ||
        environmentId !== selectedEnvironmentId()
      ) {
        return false;
      }
      if (agentModeLoadRevision === loadRevisionAtStart) {
        state.agentMode = previousMode;
        renderAgentMode();
      }
      recordControlEvent({
        type: "control",
        name: "Reasoning mode update failed",
        tone: "failed",
        summary: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      agentModeMutationInFlight = false;
      renderAgentMode();
    }
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
      return;
    }
    for (const profile of state.modelProfiles) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.label || profile.id;
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
    selectedModelSupportsImageInput,
    setAgentMode,
    setToolPermissionMode,
  };
}
