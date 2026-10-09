/** Model-scoped disclosures and keyboard position survive draft redraws. */
export function createModelPluginViewState(root) {
  const expandedSections = new Set();
  const expandedPlugins = new Set();
  const expandedRetainedRules = new Set();
  let pendingFocus = null;
  const detailSelector =
    "details[data-model-plugin-section], details[data-model-plugin-details], details[data-model-plugin-retained]";
  const controlSelector =
    '[data-config-action="model-plugin-enabled"], [data-config-action="model-plugin-capability-enabled"], [data-model-plugin-section] > summary, [data-model-plugin-details] > summary, [data-model-plugin-retained] > summary';

  function disclosureTarget(details) {
    const data = details?.dataset;
    if (!data) return null;
    if (data.modelPluginSection)
      return {
        kind: "section",
        set: expandedSections,
        key: data.modelPluginSection,
      };
    if (data.modelPluginDetails)
      return {
        kind: "plugin",
        set: expandedPlugins,
        key: JSON.stringify([data.modelId, data.modelPluginDetails]),
      };
    if (data.modelPluginRetained)
      return {
        kind: "rules",
        set: expandedRetainedRules,
        key: data.modelPluginRetained,
      };
    return null;
  }

  function remember(details) {
    if (details?.isConnected === false) return;
    const target = disclosureTarget(details);
    if (!target) return;
    if (details.open) {
      target.set.add(target.key);
      return;
    }
    target.set.delete(target.key);
  }

  function controlKey(element) {
    const data = element?.dataset;
    if (!data) return null;
    if (data.configAction === "model-plugin-enabled")
      return JSON.stringify(["plugin", data.id, data.pluginId]);
    if (data.configAction === "model-plugin-capability-enabled")
      return JSON.stringify([
        "capability",
        data.id,
        data.pluginId,
        data.capabilityId,
      ]);
    if (element.tagName !== "SUMMARY") return null;
    const details = element.parentElement;
    const target = disclosureTarget(details);
    if (!target) return null;
    return JSON.stringify(["disclosure", target.kind, target.key]);
  }

  function capture() {
    for (const details of root.querySelectorAll(detailSelector))
      remember(details);
    const active = root.ownerDocument?.activeElement;
    const key = root.contains?.(active) ? controlKey(active) : null;
    const viewport = key ? root.closest?.(".config-workspace-body") : null;
    pendingFocus = key
      ? { key, viewport, scrollTop: viewport?.scrollTop || 0 }
      : null;
  }

  function canRestoreControlFocus(target) {
    if (!target || target.isConnected === false || target.disabled)
      return false;
    if (target.closest?.("[hidden], [inert]")) return false;
    if (target.getClientRects?.().length === 0) return false;
    return true;
  }

  function restore() {
    const focus = pendingFocus;
    pendingFocus = null;
    if (!focus) return;
    const target = [...root.querySelectorAll(controlSelector)].find(
      (element) => controlKey(element) === focus.key,
    );
    if (!canRestoreControlFocus(target)) return;
    target.focus?.({ preventScroll: true });
    if (focus.viewport && focus.viewport.isConnected !== false)
      focus.viewport.scrollTop = focus.scrollTop;
  }

  function reset() {
    expandedSections.clear();
    expandedPlugins.clear();
    expandedRetainedRules.clear();
    pendingFocus = null;
  }

  return {
    expandedSections,
    expandedPlugins,
    expandedRetainedRules,
    remember,
    capture,
    restore,
    reset,
  };
}
