import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";

function blockReason(plugin, capability) {
  if (capability?.blockedReason) return capability.blockedReason;
  if (plugin.blockedByGlobalPolicy)
    return "Blocked by the global plugin policy.";
  if (capability && plugin.pluginEnabled === false)
    return "Enable this plugin to choose individual tools.";
  return capability?.blockedByPolicy
    ? "Blocked by an existing plugin policy rule."
    : "";
}

function checkbox(plugin, capability, busy) {
  const reason = blockReason(plugin, capability);
  const enabled = capability
    ? capability.enabled === true
    : plugin.pluginEnabled === true;
  const id = capability?.id || plugin.id;
  const description = capability?.description || "";
  const version =
    !capability && plugin.version
      ? `<small class="runtime-plugin-version">v${escapeHtml(plugin.version)}</small>`
      : "";
  return `<label class="runtime-plugin-choice${capability ? "" : " runtime-plugin-master"}">
    <input type="checkbox" data-runtime-plugin-toggle="${escapeAttribute(plugin.id)}" ${capability ? `data-runtime-capability="${escapeAttribute(capability.id)}"` : ""} ${enabled && !reason ? "checked" : ""} ${busy || reason ? "disabled" : ""} />
    <span><strong>${escapeHtml(id)}</strong>${version}${description ? `<small class="runtime-plugin-description" title="${escapeAttribute(description)}">${escapeHtml(description)}</small>` : ""}${reason ? `<small class="runtime-plugin-block">${escapeHtml(reason)}</small>` : ""}</span>
  </label>`;
}

function renderPluginCard(plugin, busy) {
  const capabilities = plugin.capabilities || [];
  return `<li class="runtime-plugin-card">
    ${checkbox(plugin, null, busy)}
    <p class="runtime-plugin-summary" title="${escapeAttribute(plugin.description || "")}">${escapeHtml(plugin.description || "Installed Runtime plugin.")}</p>
    <div class="runtime-plugin-tools-heading"><span>Tools</span><span>${plugin.selectedCapabilityCount} of ${capabilities.length} selected</span></div>
    <ul class="runtime-plugin-capabilities" aria-label="${escapeAttribute(`Tools in ${plugin.id}`)}">${capabilities.map((capability) => `<li>${checkbox(plugin, capability, busy)}</li>`).join("")}</ul>
  </li>`;
}

export function createSetupPluginStep({
  container,
  getEnvironmentId,
  loadPlugins,
  setPlugin,
  onChange,
}) {
  const state = {
    snapshot: null,
    loaded: false,
    busy: false,
    error: "",
    message: "",
  };
  let generation = 0;
  let focusTarget = null;
  const isCurrentPluginOperation = (revision, environment) =>
    revision === generation && environment === getEnvironmentId();

  function reset() {
    generation += 1;
    focusTarget = null;
    Object.assign(state, {
      snapshot: null,
      loaded: false,
      busy: false,
      error: "",
      message: "",
    });
  }

  async function load(force = false) {
    if ((!force && state.loaded) || state.busy) return;
    const revision = ++generation;
    const environment = getEnvironmentId();
    state.busy = true;
    state.error = "";
    onChange();
    try {
      const snapshot = await loadPlugins();
      if (!isCurrentPluginOperation(revision, environment)) return;
      state.snapshot = snapshot;
      state.loaded = true;
    } catch {
      if (isCurrentPluginOperation(revision, environment))
        state.error = "Could not load plugins. Try again before continuing.";
    } finally {
      if (isCurrentPluginOperation(revision, environment)) {
        state.busy = false;
        onChange();
      }
    }
  }

  async function toggle(target) {
    if (state.busy) return;
    const pluginId = target.dataset.runtimePluginToggle;
    const capabilityId = target.dataset.runtimeCapability;
    const plugin = state.snapshot?.plugins?.find(
      (entry) => entry.id === pluginId,
    );
    const capability = capabilityId
      ? plugin?.capabilities?.find((entry) => entry.id === capabilityId)
      : null;
    if (
      !plugin ||
      (capabilityId && !capability) ||
      blockReason(plugin, capability)
    )
      return;
    const enabled = target.checked === true;
    const revision = ++generation;
    const environment = getEnvironmentId();
    focusTarget = { pluginId, capabilityId };
    state.busy = true;
    state.error = "";
    state.message = "";
    onChange();
    try {
      const snapshot = await setPlugin({
        pluginId,
        enabled,
        ...(capabilityId ? { capabilityId } : {}),
      });
      if (!isCurrentPluginOperation(revision, environment)) return;
      state.snapshot = snapshot;
      state.message =
        "Selection saved. It will take effect when you finish setup.";
    } catch {
      if (isCurrentPluginOperation(revision, environment))
        state.error =
          "Could not save this selection. Your previous selection is still shown. Try again.";
    } finally {
      if (isCurrentPluginOperation(revision, environment)) {
        state.busy = false;
        onChange();
      }
    }
  }

  function markup() {
    const plugins = state.snapshot?.plugins || [];
    const globalBlocked =
      state.snapshot?.selection?.enabled === false ||
      state.snapshot?.selection?.deny?.includes("*");
    return `<div class="runtime-setup-plugins">
      <p class="runtime-setup-feedback">All installed plugins start enabled in a new setup. Turn off anything you do not need.</p>
      ${globalBlocked ? '<p class="runtime-setup-feedback">An existing global policy blocks plugins. Your saved policy is preserved.</p>' : ""}
      ${state.error ? `<p class="runtime-setup-feedback error" role="alert">${escapeHtml(state.error)}</p><button type="button" class="runtime-setup-inline-action" data-runtime-setup-action="plugins-reload">Reload selection</button>` : state.message ? `<p class="runtime-setup-feedback" role="status">${escapeHtml(state.message)}</p>` : ""}
      ${state.busy ? '<p class="runtime-setup-feedback" role="status">Saving or loading plugin selection…</p>' : ""}
      <ul class="runtime-plugin-list">${plugins.map((plugin) => renderPluginCard(plugin, state.busy)).join("")}</ul>
      ${state.loaded && !plugins.length ? '<p class="runtime-setup-feedback">No installed plugins found. You can add plugins later.</p>' : ""}
    </div>`;
  }

  function afterPaint({ restoreFocus = true } = {}) {
    for (const input of container.querySelectorAll?.(
      "[data-runtime-plugin-toggle]",
    ) || []) {
      input.addEventListener("change", () => void toggle(input));
      if (
        restoreFocus &&
        !state.busy &&
        focusTarget?.pluginId === input.dataset.runtimePluginToggle &&
        focusTarget?.capabilityId === input.dataset.runtimeCapability
      )
        input.focus?.({ preventScroll: true });
    }
    if (!state.busy) focusTarget = null;
  }

  return { state, reset, load, markup, afterPaint, toggle };
}
