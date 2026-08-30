import { textOf } from "../../lib/text-format.js";
import {
  cloneConfig,
  formattedConfig,
  isConfigObject,
} from "./config-model.js";

export function createConfigWorkspaceMutations({
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
  function mutateConfigFile(kind, id, mutator, options = {}) {
    const file = findConfigFile(kind, id);
    if (!file) return;
    const key = configFileKey(file);
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
    state.rawDraftsByKey.set(key, formattedConfig(baseline));
    state.savedKeys.delete(key);
    renderConfigDashboard();
  }

  function discardAllChanges() {
    for (const file of configFileEntries()) {
      const key = configFileKey(file);
      const baseline = state.baselinesByKey.get(key);
      if (!baseline) continue;
      file.config = cloneConfig(baseline);
      state.rawDraftsByKey.set(key, formattedConfig(baseline));
    }
    state.savedKeys.clear();
    renderConfigDashboard();
  }

  function prepareDiscardChanges(reason = "leave configuration") {
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
    if (!changed.length) return () => {};
    const count = changed.length;
    const confirmed = confirmDiscard(
      `Discard unsaved changes in ${count} config ${
        count === 1 ? "file" : "files"
      } and ${reason}?`,
    );
    if (!confirmed) return null;
    return discardAllChanges;
  }

  function confirmDiscardChanges(reason = "leave configuration") {
    const discardChanges = prepareDiscardChanges(reason);
    if (!discardChanges) return false;
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
    ensureRawSelection();
    renderConfigDashboard();
  }

  function clearDashboardSnapshot() {
    state.configDashboard = null;
    state.baselinesByKey.clear();
    state.rawDraftsByKey.clear();
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

  function keepOrDiscardCurrentRawDraft(currentFile, select) {
    if (!currentFile || !hasRawDraftChanges(currentFile)) return true;
    const confirmed = confirmDiscard(
      `Discard the unapplied raw draft for ${textOf(
        currentFile.label || currentFile.id,
      )}?`,
    );
    if (!confirmed) {
      select.value = state.selectedRawConfigKey;
      return false;
    }
    state.rawDraftsByKey.set(
      configFileKey(currentFile),
      formattedConfig(currentFile.config),
    );
    return true;
  }

  function changeRawFile(nextKey, select) {
    const currentFile = selectedRawConfigFile();
    if (!keepOrDiscardCurrentRawDraft(currentFile, select)) return;
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
