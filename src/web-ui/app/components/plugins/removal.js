function isDefinitiveRemovalRejection(error) {
  if (!(error.status >= 400 && error.status < 500)) return false;
  return [
    "plugin_not_removable",
    "plugin_not_found",
    "invalid_plugin_configuration",
    "plugin_selection_conflict",
    "plugin_mutation_unavailable",
    "invalid_plugin_removal",
    "runtime_setup_required",
    "plugin_removal_unavailable",
    "request_origin_required",
    "method_not_allowed",
    "configuration_request_rejected",
    "plugin_runtime_busy",
    "plugin_owner_unavailable",
  ].includes(error.code);
}

/** Removal is an explicit local action; busy owners keep their files until a retry. */
export function createPluginRemoval({
  removePlugin,
  getEnvironmentId,
  beginRuntimeMutation,
  endRuntimeMutation,
  refreshRuntimeConfig,
  onConfigurationSaved,
  onConfigurationApplied,
  onConfigurationSettled = () => true,
  onSnapshot,
  render,
  confirmRemoval = (message) => window.confirm(message),
}) {
  const state = { busy: false, message: "", error: "" };
  let environment = getEnvironmentId();
  let generation = 0;
  function resetEnvironment() {
    if (environment === getEnvironmentId()) return;
    environment = getEnvironmentId();
    generation += 1;
    Object.assign(state, { busy: false, message: "", error: "" });
  }
  async function remove(pluginId) {
    resetEnvironment();
    if (state.busy || !removePlugin) return false;
    if (
      !confirmRemoval(
        `Remove ${pluginId}? This disables the plugin, applies the change when Runtime is idle, and deletes its installed folder. If Runtime is busy, try Remove again after it finishes.`,
      )
    )
      return false;
    if (!beginRuntimeMutation("plugin removal")) return false;
    const request = ++generation;
    const selected = environment;
    const current = () =>
      request === generation && selected === getEnvironmentId();
    Object.assign(state, { busy: true, message: "", error: "" });
    render();
    let removed = false;
    let activated = false;
    try {
      const result = await removePlugin({ pluginId }, selected);
      if (!current()) return false;
      removed = result.removed === true;
      onSnapshot(result);
      state.message = result.message;
      activated = result.activation?.status === "ready";
      if (activated) await onConfigurationApplied();
      else onConfigurationSaved();
      if (!current()) return false;
      const refreshed = await refreshRuntimeConfig(
        "Plugin removal; refresh required",
      );
      if (!current()) return false;
      if (!refreshed)
        state.error = "Refresh configuration before making more changes.";
      return removed;
    } catch (error) {
      if (!current()) return false;
      state.error =
        (removed ? "Plugin removed; refresh failed: " : "") +
        (error.message || String(error));
      if (removed || activated) return false;
      activated = error.payload?.activation?.status === "ready";
      if (!activated && isDefinitiveRemovalRejection(error)) return false;
      let projectionRefreshed = true;
      if (activated) {
        projectionRefreshed = await Promise.resolve()
          .then(onConfigurationApplied)
          .then(
            () => true,
            () => false,
          );
        if (!current()) return false;
      }
      // Apply may have succeeded for an older revision while a newer save is pending.
      if (!activated || error.code === "config_changed") onConfigurationSaved();
      const refreshed = await refreshRuntimeConfig(
        "Plugin removal incomplete; refresh required",
      ).catch(() => false);
      if (current() && (!projectionRefreshed || !refreshed))
        state.error += " Refresh configuration before making more changes.";
      return false;
    } finally {
      endRuntimeMutation();
      if (current()) state.busy = false;
      if (activated && current()) {
        try {
          if (onConfigurationSettled() === false)
            state.error = [
              state.error,
              "Finish your current edits, then refresh configuration to update environments.",
            ]
              .filter(Boolean)
              .join(" ");
        } catch {
          state.error = [
            state.error,
            "Refresh configuration to update environments.",
          ]
            .filter(Boolean)
            .join(" ");
        }
      }
      if (current()) render();
    }
  }

  return { state, remove, resetEnvironment };
}
