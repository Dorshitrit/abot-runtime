import { createPluginConfigurationEditor } from "./configuration-editor.js";
import { createPluginRemoval } from "./removal.js";
import { renderPluginManager } from "./rendering.js";
import { createPluginViewState } from "./view-state.js";
import { createPluginInstallation } from "./installation.js";
import { renderPluginTabs, bindPluginTabs } from "./tabs.js";
import { projectPluginSummary } from "./summary.js";

export function createPluginManager({
  loadPlugins,
  loadConfiguration,
  saveConfiguration,
  inspectPlugin,
  installPlugin,
  removePlugin,
  confirmRemoval,
  onConfigurationApplied = async () => {},
  onConfigurationSettled = () => true,
  onNavigationChange = () => {},
  getEnvironmentId = () => "",
  setPlugin,
  beginRuntimeMutation = () => true,
  refreshRuntimeConfig = async () => true,
  endRuntimeMutation = () => {},
  recordControlEvent = () => {},
  onConfigurationSaved = () => {},
  onSummaryChange = () => {},
}) {
  const viewState = createPluginViewState();
  const state = {
    root: null,
    activeTab: "installed",
    snapshot: null,
    busy: false,
    message: "",
    error: "",
    loadGeneration: 0,
    mutationGeneration: 0,
    environmentId: getEnvironmentId(),
  };

  const configurationEditor = createPluginConfigurationEditor({
    loadConfiguration,
    saveConfiguration,
    getEnvironmentId,
    beginRuntimeMutation,
    endRuntimeMutation,
    onConfigurationSaved,
    onClosed: onConfigurationSettled,
  });

  const installation = createPluginInstallation({
    inspectPlugin,
    installPlugin,
    getEnvironmentId,
    beginRuntimeMutation,
    endRuntimeMutation,
    refreshRuntimeConfig,
    onConfigurationSaved,
    onInstalled: (snapshot) => {
      state.snapshot = snapshot;
      state.error = "";
      state.message = "";
      removal.state.message = "";
      removal.state.error = "";
      activateTab("installed", true);
    },
    render,
  });

  const removal = createPluginRemoval({
    removePlugin,
    confirmRemoval,
    getEnvironmentId,
    beginRuntimeMutation,
    endRuntimeMutation,
    refreshRuntimeConfig,
    onConfigurationSaved,
    onConfigurationApplied,
    onConfigurationSettled,
    render,
    onSnapshot: (snapshot) => {
      state.snapshot = snapshot;
    },
  });

  async function remove(pluginId) {
    if (state.busy || installation.state.busy || removal.state.busy)
      return false;
    if (
      !state.snapshot?.plugins?.some(
        (plugin) => plugin.id === pluginId && plugin.removable,
      )
    )
      return false;
    installation.state.installedPluginId = null;
    state.message = "";
    state.error = "";
    return removal.remove(pluginId);
  }

  function activateTab(name, focus = false) {
    if (!["installed", "discover"].includes(name)) return;
    if (installation.state.dirty && name !== state.activeTab) return;
    state.activeTab = name;
    render();
    if (focus)
      state.root?.querySelector(`[data-plugin-tab="${name}"]`)?.focus();
    onNavigationChange();
  }

  function render({ capture = true } = {}) {
    installation.resetEnvironment();
    removal.resetEnvironment();
    onSummaryChange();
    if (!state.root) return;
    if (capture) viewState.capture(state.root);
    installation.captureFields(state.root);
    state.root.innerHTML = renderPluginTabs(
      renderPluginManager({
        ...state,
        busy: state.busy || installation.state.busy || removal.state.busy,
        canRemove: typeof removePlugin === "function",
        canConfigure: typeof loadConfiguration === "function",
        message:
          removal.state.message ||
          (installation.state.installedPluginId
            ? installation.state.message
            : state.message),
        error:
          state.error ||
          removal.state.error ||
          (installation.state.installedPluginId
            ? installation.state.error
            : ""),
        openPluginIds: viewState.openPluginIds,
      }),
      installation.state,
      state.activeTab,
    );
    for (const button of state.root.querySelectorAll("[data-plugin-configure]"))
      button.addEventListener(
        "click",
        () =>
          void configurationEditor.open(
            button.dataset.pluginConfigure,
            state.root,
          ),
      );
    bindPluginTabs(state.root, activateTab);
    installation.bind(state.root);
    viewState.bind(state.root, () => render({ capture: false }));
    state.root
      .querySelector("[data-plugin-refresh]")
      ?.addEventListener("click", load);
    for (const button of state.root.querySelectorAll("[data-plugin-toggle]")) {
      button.addEventListener("click", () =>
        toggle(
          button.dataset.pluginToggle,
          button.dataset.pluginEnabled === "true",
        ),
      );
    }
    for (const input of state.root.querySelectorAll(
      "[data-plugin-capability-toggle]",
    )) {
      input.addEventListener("change", () =>
        toggle(
          input.dataset.pluginParent,
          input.checked,
          input.dataset.pluginCapabilityToggle,
        ),
      );
    }
    for (const button of state.root.querySelectorAll("[data-plugin-remove]"))
      button.addEventListener(
        "click",
        () => void remove(button.dataset.pluginRemove),
      );
    viewState.restore(
      state.root,
      state.busy || installation.state.busy || removal.state.busy,
    );
  }

  function mount(root) {
    viewState.capture(state.root);
    state.root = root;
    render();
  }

  function isLatestPluginLoad(generation) {
    if (generation !== state.loadGeneration) return false;
    return state.environmentId === getEnvironmentId();
  }

  async function load() {
    const environmentId = getEnvironmentId();
    if (state.environmentId !== environmentId) {
      state.environmentId = environmentId;
      viewState.reset();
      state.mutationGeneration += 1;
      state.snapshot = null;
      state.message = "";
    }
    const generation = ++state.loadGeneration;
    state.busy = true;
    state.error = "";
    render();
    try {
      const snapshot = await loadPlugins();
      if (!isLatestPluginLoad(generation)) return false;
      state.snapshot = snapshot;
      return true;
    } catch (error) {
      if (!isLatestPluginLoad(generation)) return false;
      state.snapshot = null;
      state.error = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      if (isLatestPluginLoad(generation)) {
        state.busy = false;
        render();
      }
    }
  }

  function isCurrentPluginMutation(generation, environmentId) {
    if (generation !== state.mutationGeneration) return false;
    return environmentId === getEnvironmentId();
  }

  function markApplied() {
    installation.markApplied();
    state.message = "Plugin selection applied to this environment.";
    state.error = "";
    render();
  }

  function canChangePluginSelection(pluginId, capabilityId) {
    const plugin = state.snapshot?.plugins?.find(
      (entry) => entry.id === pluginId,
    );
    if (!plugin || plugin.blockedByGlobalPolicy) return false;
    if (!capabilityId) return true;
    if (plugin.pluginEnabled === false) return false;
    const capability = plugin.capabilities?.find(
      (entry) => entry.id === capabilityId,
    );
    if (!capability) return false;
    return capability.blockedByPolicy !== true;
  }

  async function toggle(pluginId, enabled, capabilityId) {
    if (state.busy || installation.state.busy || removal.state.busy)
      return false;
    if (!canChangePluginSelection(pluginId, capabilityId)) return false;
    if (!beginRuntimeMutation("plugin settings")) {
      render();
      return false;
    }
    ++state.loadGeneration;
    const generation = ++state.mutationGeneration;
    const environmentId = getEnvironmentId();
    state.busy = true;
    state.error = "";
    state.message = "";
    installation.state.installedPluginId = null;
    removal.state.message = "";
    removal.state.error = "";
    let saved = false;
    render();
    try {
      const snapshot = await setPlugin({
        pluginId,
        enabled,
        ...(capabilityId ? { capabilityId } : {}),
      });
      if (!isCurrentPluginMutation(generation, environmentId)) return false;
      state.snapshot = snapshot;
      saved = true;
      onConfigurationSaved();
      state.message =
        "Plugin selection saved. Apply changes or restart Runtime to use it.";
      recordControlEvent({
        type: "control",
        name: "Plugin selection saved",
        tone: "done",
        summary: `${capabilityId ? `${pluginId}:${capabilityId}` : pluginId}: saved; Runtime application required`,
      });
      const refreshed = await refreshRuntimeConfig(
        "Plugin selection saved; refresh required",
      );
      if (!isCurrentPluginMutation(generation, environmentId)) return false;
      if (!refreshed) {
        state.message =
          "Plugin selection saved. Refresh configuration before making more changes. Runtime application is still required.";
      }
      return true;
    } catch (error) {
      if (!isCurrentPluginMutation(generation, environmentId)) return false;
      const message = error instanceof Error ? error.message : String(error);
      state.error = saved
        ? `Plugin selection saved; configuration refresh failed: ${message}`
        : message;
      recordControlEvent({
        type: "control",
        name: saved
          ? "Plugin selection refresh failed"
          : "Plugin selection failed",
        tone: "failed",
        summary: state.error,
      });
      return false;
    } finally {
      endRuntimeMutation();
      if (generation === state.mutationGeneration) {
        state.busy = false;
        render();
      }
    }
  }

  return {
    summary: () =>
      projectPluginSummary(
        {
          ...state,
          busy: state.busy || installation.state.busy || removal.state.busy,
        },
        getEnvironmentId(),
      ),
    hasConfigurationDraft: () =>
      configurationEditor.isOpen() || installation.state.dirty,
    activeTab: () => state.activeTab,
    openRoute: (route) => {
      activateTab(route.pluginSource ? "discover" : route.tab || "installed");
      if (!route.pluginSource) return true;
      void installation.inspect({
        repository: route.pluginSource,
        ref: route.pluginRef || "",
        path: route.pluginPath || "",
      });
      return true;
    },
    load,
    markApplied,
    mount,
    toggle,
    remove,
    toggleCapability: (pluginId, capabilityId, enabled) =>
      toggle(pluginId, enabled, capabilityId),
  };
}
