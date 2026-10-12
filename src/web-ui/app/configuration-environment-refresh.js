import { createConfigurationFeature as createWorkspaceFeature } from "./configuration-feature.js";
import { textOf } from "./lib/text-format.js";

export function createAppliedEnvironmentProjection({
  state,
  dom,
  selection,
  loadWebConfig,
  changeEnvironment,
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

  function applyProjection(config, selected) {
    state.config = config;
    selection.renderEnvironmentOptions();
    dom.environmentSelect.value = selected;
  }

  function preferredEnvironmentId(options, selected, defaultId) {
    if (options.some(({ value }) => value === selected)) return selected;
    if (options.some(({ value }) => value === defaultId)) return defaultId;
    return options[0]?.value || "";
  }

  async function flush() {
    if (!pending) return "unchanged";
    const previousEnvironment = selection.selectedEnvironmentId();
    const projected = pending;
    const revision = generation;
    const next = preferredEnvironmentId(
      selection.configuredEnvironmentOptions(projected),
      previousEnvironment,
      textOf(projected.defaultEnvironmentId).trim(),
    );
    if (!next) return "blocked";
    if (next === previousEnvironment) {
      applyProjection(projected, next);
      pending = null;
      selection.renderAgentPicker();
      return "unchanged";
    }
    // Keep the old catalog and selected option until draft preparation commits.
    const commitEnvironmentOptions = () => {
      applyProjection(projected, next);
      pending = null;
    };
    commitEnvironmentOptions.canCommit = () => {
      if (revision !== generation) return false;
      return pending === projected;
    };
    let accepted = false;
    try { accepted = await changeEnvironment(next, { commitEnvironmentOptions }); }
    catch { /* The old catalog remains active when draft persistence fails. */ }
    if (!accepted) return "blocked";
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
  changeEnvironment,
  ...options
}) {
  const projection = createAppliedEnvironmentProjection({
    state,
    dom: options.dom,
    selection,
    loadWebConfig: () => options.runtimeClient.loadWebConfig(),
    changeEnvironment,
  });
  const workspace = createWorkspaceFeature({
    ...options,
    onConfigurationApplied: async () => {
      const currentStillConfigured = await projection.prepare();
      if (currentStillConfigured) await onConfigurationApplied();
    },
    onConfigurationSettled: async () => await projection.flush() !== "blocked",
  });
  return {
    ...workspace,
    async reloadAppliedEnvironmentModels() {
      await projection.prepare();
      const result = await projection.flush();
      if (result === "blocked") return false;
      if (result === "changed") return true;
      const refreshed = await workspace.load();
      const modelsLoaded = await onConfigurationApplied();
      return refreshed !== false && modelsLoaded !== false;
    },
  };
}
