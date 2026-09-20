import { createConfigurationFeature as createWorkspaceFeature } from "./configuration-feature.js";
import { textOf } from "./lib/text-format.js";

export function createAppliedEnvironmentProjection({
  state,
  dom,
  selection,
  loadWebConfig,
}) {
  let generation = 0;
  let pending = null;

  async function prepare() {
    const revision = ++generation;
    pending = null;
    const config = await loadWebConfig();
    if (revision !== generation) return null;
    pending = config;
    const selected = selection.selectedEnvironmentId();
    return (
      Array.isArray(config.environments) &&
      config.environments.some(({ id }) => textOf(id).trim() === selected)
    );
  }

  function restoreProjection(config, selected) {
    state.config = config;
    selection.renderEnvironmentOptions();
    dom.environmentSelect.value = selected;
    selection.renderAgentPicker();
  }

  function preferredEnvironmentId(options, selected, defaultId) {
    if (options.some(({ value }) => value === selected)) return selected;
    if (options.some(({ value }) => value === defaultId)) return defaultId;
    return options[0]?.value || "";
  }

  function changeProjectedEnvironment(
    next,
    previousConfig,
    previousEnvironment,
  ) {
    const ChangeEvent = dom.environmentSelect.ownerDocument.defaultView.Event;
    dom.environmentSelect.dispatchEvent(new ChangeEvent("change"));
    if (dom.environmentSelect.value === next) return true;
    restoreProjection(previousConfig, previousEnvironment);
    // Existing listeners also own composer/environment presentation after a refusal.
    dom.environmentSelect.dispatchEvent(new ChangeEvent("change"));
    return false;
  }

  function flush() {
    if (!pending) return "unchanged";
    const previousConfig = state.config;
    const previousEnvironment = selection.selectedEnvironmentId();
    state.config = pending;
    selection.renderEnvironmentOptions();
    const next = preferredEnvironmentId(
      selection.environmentOptions(),
      previousEnvironment,
      textOf(pending.defaultEnvironmentId).trim(),
    );
    if (!next) {
      restoreProjection(previousConfig, previousEnvironment);
      return "blocked";
    }
    dom.environmentSelect.value = next;
    const unchanged = next === previousEnvironment;
    if (unchanged) {
      pending = null;
      selection.renderAgentPicker();
      return "unchanged";
    }
    if (!changeProjectedEnvironment(next, previousConfig, previousEnvironment))
      return "blocked";
    pending = null;
    selection.renderAgentPicker();
    return "changed";
  }

  return { prepare, flush };
}

/** Stage applied metadata under the mutation lock, then use normal navigation after release. */
export function createConfigurationFeature({
  state,
  selection,
  onConfigurationApplied,
  ...options
}) {
  const projection = createAppliedEnvironmentProjection({
    state,
    dom: options.dom,
    selection,
    loadWebConfig: () => options.runtimeClient.loadWebConfig(),
  });
  const workspace = createWorkspaceFeature({
    ...options,
    onConfigurationApplied: async () => {
      const currentStillConfigured = await projection.prepare();
      if (currentStillConfigured) await onConfigurationApplied();
    },
    onConfigurationSettled: () => projection.flush() !== "blocked",
  });
  return {
    ...workspace,
    async reloadAppliedEnvironmentModels() {
      await projection.prepare();
      const result = projection.flush();
      if (result === "blocked") return false;
      if (result === "changed") return true;
      const refreshed = await workspace.load();
      const modelsLoaded = await onConfigurationApplied();
      return refreshed !== false && modelsLoaded !== false;
    },
  };
}
