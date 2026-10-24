import {
  malformedConfigRaw,
  configRequiresRawRepair,
  selectMalformedConfigForRepair,
} from "./raw-config-repair.js";
import { textOf } from "../../lib/text-format.js";
import {
  cloneConfig,
  formattedConfig,
  isConfigObject,
} from "./config-model.js";

export function createConfigWorkspaceMutations({
  modelPluginViewState,
  state,
  dom,
  confirmDiscard,
  recordControlEvent,
  captureBaselines,
  configFileEntries,
  configFileKey,
  dirtyFiles,
  ensureRawSelection,
  findConfigFile,
  hasRawDraftChanges,
  rawDraftFor,
  renderConfigDashboard,
  selectedRawConfigFile,
  setWorkspaceStatus,
  syncDirtyPresentation,
}) {
  let discardRequest = 0;

  function mutateConfigFile(kind, id, mutator, options = {}) {
    const file = findConfigFile(kind, id);
    if (!file) return;
    const key = configFileKey(file);
    if (configRequiresRawRepair(file, state.appliedJsonRepairKeys.has(key))) {
      setWorkspaceStatus(
        "Repair this file in the configuration repair section before editing its fields.",
        "error-text",
      );
      return;
    }
    const shouldFollowStructuredConfig = !hasRawDraftChanges(file);
    mutator(file.config);
    state.savedKeys.delete(key);
    if (shouldFollowStructuredConfig) {
      state.rawDraftsByKey.set(key, formattedConfig(file.config));
    }
    if (options.rerender) {
      renderConfigDashboard();
      return;
    }
    syncDirtyPresentation({ syncRawEditor: shouldFollowStructuredConfig });
  }

  function resetConfigFile(kind, id) {
    const file = findConfigFile(kind, id);
    if (!file) return;
    const key = configFileKey(file);
    const baseline = state.baselinesByKey.get(key);
    if (!baseline) return;
    file.config = cloneConfig(baseline);
    state.appliedJsonRepairKeys.delete(key);
    state.rawDraftsByKey.set(key, malformedConfigRaw(file) ?? formattedConfig(baseline));
    state.savedKeys.delete(key);
    renderConfigDashboard();
  }

  function discardAllChanges() {
    for (const file of configFileEntries()) {
      const key = configFileKey(file);
      const baseline = state.baselinesByKey.get(key);
      if (!baseline) continue;
      file.config = cloneConfig(baseline);
      state.appliedJsonRepairKeys.delete(key);
      state.rawDraftsByKey.set(key, malformedConfigRaw(file) ?? formattedConfig(baseline));
    }
    state.savedKeys.clear();
    renderConfigDashboard();
  }

  async function prepareDiscardChanges(reason = "leave configuration") {
    discardRequest += 1;
    if (state.externalRuntimeMutationInFlight) {
      setWorkspaceStatus(
        `Wait for the current Runtime update before you ${reason}.`,
        "error-text",
      );
      return null;
    }
    if (state.savingKeys.size > 0) {
      setWorkspaceStatus(
        `Wait for the current save before you ${reason}.`,
        "error-text",
      );
      return null;
    }
    const changed = dirtyFiles();
    if (!changed.length) return prepareConfigDiscardCommit(false);
    const count = changed.length;
    const discard = prepareConfigDiscardCommit(true);
    const confirmed = await confirmDiscard(
      `Discard unsaved changes in ${count} config ${
        count === 1 ? "file" : "files"
      } and ${reason}?`,
    );
    if (!confirmed || !discard.canCommit()) return null;
    return discard;
  }

  function configDraftFingerprint() {
    return JSON.stringify(configFileEntries().map((file) => {
      const key = configFileKey(file);
      return [key, file.config, state.rawDraftsByKey.get(key), state.baselinesByKey.get(key), state.appliedJsonRepairKeys.has(key)];
    }));
  }

  function prepareConfigDiscardCommit(hasChanges) {
    const request = discardRequest;
    const dashboard = state.configDashboard;
    const fingerprint = configDraftFingerprint();
    const commit = () => {
      if (!commit.canCommit()) return false;
      if (hasChanges) discardAllChanges();
      return true;
    };
    commit.canCommit = () => {
      if (request !== discardRequest) return false;
      if (state.externalRuntimeMutationInFlight) return false;
      if (state.savingKeys.size > 0) return false;
      if (state.configDashboard !== dashboard) return false;
      return configDraftFingerprint() === fingerprint;
    };
    return commit;
  }

  async function confirmDiscardChanges(reason = "leave configuration") {
    const discardChanges = await prepareDiscardChanges(reason);
    if (!discardChanges || !discardChanges.canCommit()) return false;
    discardChanges();
    return true;
  }

  function replaceDashboard(payload) {
    state.configDashboard = payload.dashboard || null;
    captureBaselines();
    const models = state.configDashboard?.files?.models || [];
    if (!models.some((model) => model.id === state.selectedConfigModelId)) {
      state.selectedConfigModelId = models[0]?.id || "";
    }
    selectMalformedConfigForRepair(state, configFileEntries(), configFileKey);
    ensureRawSelection();
    renderConfigDashboard();
  }

  function clearDashboardSnapshot() {
    modelPluginViewState?.reset();
    state.configDashboard = null;
    state.baselinesByKey.clear();
    state.rawDraftsByKey.clear();
    state.appliedJsonRepairKeys.clear();
    state.savedKeys.clear();
    state.selectedRawConfigKey = "";
    dom.configDashboard.innerHTML = "";
  }

  function parseRawDraft(file) {
    const editor = dom.configDashboard.querySelector("#configRawEditor");
    const draft = editor?.value ?? rawDraftFor(file);
    const parsed = JSON.parse(draft);
    if (!isConfigObject(parsed)) {
      throw new Error("Raw config must be a JSON object");
    }
    return parsed;
  }

  function reportInvalidRaw(error) {
    const summary = error instanceof Error ? error.message : String(error);
    setWorkspaceStatus(`Raw JSON: ${summary}`, "error-text");
    recordControlEvent({
      type: "control",
      name: "Raw config invalid",
      tone: "failed",
      summary,
    });
  }

  function applyRawDraft() {
    const file = selectedRawConfigFile();
    if (!file) return null;
    try {
      const parsed = parseRawDraft(file);
      file.config = parsed;
      const key = configFileKey(file);
      if (malformedConfigRaw(file) !== undefined)
        state.appliedJsonRepairKeys.add(key);
      state.rawDraftsByKey.set(key, formattedConfig(parsed));
      state.savedKeys.delete(key);
      setWorkspaceStatus("");
      renderConfigDashboard();
      return file;
    } catch (error) {
      reportInvalidRaw(error);
      return null;
    }
  }

  async function keepOrDiscardCurrentRawDraft(currentFile, select) {
    discardRequest += 1;
    if (!currentFile || !hasRawDraftChanges(currentFile)) return true;
    const original = prepareConfigDiscardCommit(false);
    const confirmed = await confirmDiscard(
      `Discard the unapplied raw draft for ${textOf(
        currentFile.label || currentFile.id,
      )}?`,
    );
    if (!original.canCommit()) return false;
    if (!confirmed) {
      select.value = state.selectedRawConfigKey;
      return false;
    }
    state.rawDraftsByKey.set(
      configFileKey(currentFile),
      configRequiresRawRepair(currentFile, state.appliedJsonRepairKeys.has(configFileKey(currentFile)))
        ? malformedConfigRaw(currentFile)
        : formattedConfig(currentFile.config),
    );
    return true;
  }

  async function changeRawFile(nextKey, select) {
    const currentFile = selectedRawConfigFile();
    const dashboard = state.configDashboard;
    const currentKey = state.selectedRawConfigKey;
    const pending = keepOrDiscardCurrentRawDraft(currentFile, select);
    const request = discardRequest;
    if (!await pending) return;
    if (request !== discardRequest) return;
    if (dashboard !== state.configDashboard) return;
    if (currentKey !== state.selectedRawConfigKey) return;
    state.selectedRawConfigKey = nextKey;
    syncDirtyPresentation({ syncRawEditor: true });
  }

  return {
    applyRawDraft,
    changeRawFile,
    clearDashboardSnapshot,
    confirmDiscardChanges,
    mutateConfigFile,
    prepareDiscardChanges,
    replaceDashboard,
    resetConfigFile,
  };
}
