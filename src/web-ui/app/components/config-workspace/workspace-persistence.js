import { textOf } from "../../lib/text-format.js";
import {
  cloneConfig,
  modelContextWindowValidationError,
  runtimeConfigGraphChanged,
} from "./config-model.js";

export function createConfigWorkspacePersistence({
  state,
  dom,
  loadDashboard,
  saveFile,
  memorySetup,
  memoryManagement,
  recordControlEvent,
  applyRawDraft,
  baselineFor,
  clearDashboardSnapshot,
  configFileKey,
  confirmDiscardChanges,
  dashboardIsBusy,
  dirtyFiles,
  findConfigFile,
  hasRawDraftChanges,
  hasUnsavedChanges,
  isFileDirty,
  replaceDashboard,
  setWorkspaceStatus,
  syncDashboardInteractivity,
  syncDirtyPresentation,
}) {
  function configLoadIsStale(loadGeneration) {
    return loadGeneration !== state.loadGeneration;
  }

  function finishCurrentConfigLoad(loadGeneration) {
    if (configLoadIsStale(loadGeneration)) return;
    state.loading = false;
    syncDashboardInteractivity();
  }

  function externalRuntimeMutationBlockReason() {
    if (hasUnsavedChanges()) {
      return "Save or reset configuration changes before changing Runtime memory settings.";
    }
    if (dashboardIsBusy() || state.savingKeys.size > 0) {
      return "Wait for the current configuration operation before changing Runtime memory settings.";
    }
    return "";
  }

  function canonicalRefreshFailurePrefix(kind) {
    return kind === "runtime"
      ? "Runtime saved; refresh required"
      : "Config saved; refresh required";
  }

  function canonicalDashboardRefreshOptions(kind) {
    return {
      protectUnsaved: false,
      failurePrefix: canonicalRefreshFailurePrefix(kind),
    };
  }

  function recordCanonicalRefreshFailure(refreshed) {
    if (refreshed) return;
    recordControlEvent({
      type: "control",
      name: "Config refresh required",
      tone: "failed",
      summary: textOf(dom.configStatus.textContent),
    });
  }

  async function loadRuntimeConfig(options = {}) {
    const protectUnsaved = options.protectUnsaved !== false;
    if (protectUnsaved && !confirmDiscardChanges("refresh configuration")) {
      return false;
    }
    if (options.clearBeforeLoad === true) {
      clearDashboardSnapshot();
    }
    const loadGeneration = ++state.loadGeneration;
    state.loading = true;
    setWorkspaceStatus("Loading…");
    syncDashboardInteractivity();
    try {
      const payload = await loadDashboard();
      if (configLoadIsStale(loadGeneration)) return false;
      replaceDashboard(payload);
      const memoryLoads = [memoryManagement.load()];
      if (options.loadMemorySetup !== false) {
        memoryLoads.unshift(memorySetup.load());
      }
      const memoryResults = await Promise.allSettled(memoryLoads);
      if (configLoadIsStale(loadGeneration)) return false;
      const memoryFailure = memoryResults.find(
        (result) => result.status === "rejected",
      );
      if (memoryFailure?.status === "rejected") {
        const summary =
          memoryFailure.reason instanceof Error
            ? memoryFailure.reason.message
            : String(memoryFailure.reason);
        setWorkspaceStatus(
          `Configuration loaded; memory controls unavailable: ${summary}`,
          "error-text",
        );
      } else {
        setWorkspaceStatus("");
      }
      return true;
    } catch (error) {
      if (configLoadIsStale(loadGeneration)) return false;
      const failurePrefix = textOf(options.failurePrefix).trim();
      const summary = error instanceof Error ? error.message : String(error);
      setWorkspaceStatus(
        failurePrefix ? `${failurePrefix}: ${summary}` : summary,
        "error-text",
      );
      if (!state.configDashboard) {
        dom.configDashboard.innerHTML = "";
      }
      return false;
    } finally {
      finishCurrentConfigLoad(loadGeneration);
    }
  }

  function beginExternalRuntimeMutation() {
    const blockReason = externalRuntimeMutationBlockReason();
    if (blockReason) {
      setWorkspaceStatus(blockReason, "error-text");
      return false;
    }
    state.externalRuntimeMutationInFlight = true;
    syncDashboardInteractivity();
    return true;
  }

  async function refreshAfterExternalRuntimeMutation() {
    if (!state.externalRuntimeMutationInFlight) return false;
    return loadRuntimeConfig({
      protectUnsaved: false,
      clearBeforeLoad: true,
      loadMemorySetup: false,
      failurePrefix: "Memory updated; refresh required",
    });
  }

  function endExternalRuntimeMutation() {
    state.externalRuntimeMutationInFlight = false;
    syncDashboardInteractivity();
  }

  async function saveConfigFile(kind, id) {
    const file = findConfigFile(kind, id);
    if (!file || !isFileDirty(file)) return;
    const key = configFileKey(file);
    const configToSave = cloneConfig(file.config);
    const contextWindowError =
      file.kind === "model"
        ? modelContextWindowValidationError(configToSave)
        : "";
    if (contextWindowError) {
      setWorkspaceStatus(contextWindowError, "error-text");
      return false;
    }
    const refreshRuntimeGraph =
      kind === "runtime" &&
      runtimeConfigGraphChanged(baselineFor(file), configToSave);
    const refreshCanonicalDashboard =
      refreshRuntimeGraph || file.source?.type === "inlineModelProfile";
    const rawDraftWasPending = hasRawDraftChanges(file);
    if (refreshCanonicalDashboard && rawDraftWasPending) {
      setWorkspaceStatus(
        "Apply or reset the current raw draft before saving Runtime-linked configuration.",
        "error-text",
      );
      return false;
    }
    const dirtyLinkedFiles = refreshCanonicalDashboard
      ? dirtyFiles().filter((entry) => configFileKey(entry) !== key)
      : [];
    if (dirtyLinkedFiles.length > 0) {
      setWorkspaceStatus(
        "Save or reset linked config changes before updating Runtime-linked configuration.",
        "error-text",
      );
      return false;
    }
    state.savingKeys.add(key);
    state.canonicalRefreshInFlight = refreshCanonicalDashboard;
    syncDashboardInteractivity();
    syncDirtyPresentation();
    try {
      const result = await saveFile({ kind, id, config: configToSave });
      state.baselinesByKey.set(key, cloneConfig(configToSave));
      state.savedKeys.add(key);
      recordControlEvent({
        type: "control",
        name: "Config saved",
        tone: "done",
        summary: result?.backupPath
          ? `backup: ${result.backupPath}`
          : "restart required",
      });
      if (refreshCanonicalDashboard) {
        clearDashboardSnapshot();
        const refreshed = await loadRuntimeConfig(
          canonicalDashboardRefreshOptions(kind),
        );
        recordCanonicalRefreshFailure(refreshed);
        return refreshed;
      }
      return true;
    } catch (error) {
      recordControlEvent({
        type: "control",
        name: "Config save failed",
        tone: "failed",
        summary: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      state.savingKeys.delete(key);
      state.canonicalRefreshInFlight = false;
      syncDashboardInteractivity();
      syncDirtyPresentation({ syncRawEditor: !rawDraftWasPending });
    }
  }

  async function saveRawDraft() {
    const file = applyRawDraft();
    if (!file) return;
    await saveConfigFile(file.kind, file.id);
  }

  return {
    beginExternalRuntimeMutation,
    endExternalRuntimeMutation,
    loadRuntimeConfig,
    refreshAfterExternalRuntimeMutation,
    saveConfigFile,
    saveRawDraft,
  };
}
