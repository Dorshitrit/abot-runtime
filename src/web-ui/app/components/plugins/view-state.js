/** Card view, keyboard position and list scroll survive configuration refreshes. */
export function createPluginViewState() {
  const openPluginIds = new Set();
  const toolScrollPositions = new Map();
  let focusedControl = null;
  let scrollPosition = null;

  function controlIdentity(element) {
    if (!element?.dataset) return null;
    if (element.dataset.pluginCapabilityToggle) {
      return { kind: "capability", pluginId: element.dataset.pluginParent, capabilityId: element.dataset.pluginCapabilityToggle };
    }
    if (element.dataset.pluginToggle) return { kind: "plugin", pluginId: element.dataset.pluginToggle };
    if (element.dataset.pluginToolsOpen) return { kind: "open", pluginId: element.dataset.pluginToolsOpen };
    if (element.dataset.pluginToolsBack) return { kind: "back", pluginId: element.dataset.pluginToolsBack };
    if (Object.hasOwn(element.dataset, "pluginRefresh")) return { kind: "refresh" };
    return null;
  }

  function rememberScroll(root) {
    if (scrollPosition) return;
    const viewport = root.closest?.(".config-workspace-body");
    if (viewport) scrollPosition = { viewport, top: viewport.scrollTop };
  }

  function captureToolScroll(root) {
    for (const list of root.querySelectorAll("[data-plugin-tools-scroll]")) {
      const pluginId = list.dataset.pluginToolsScroll;
      if (!openPluginIds.has(pluginId)) continue;
      toolScrollPositions.set(pluginId, list.scrollTop);
    }
  }

  function capture(root) {
    if (!root || root.isConnected === false) return;
    captureToolScroll(root);
    const active = root.ownerDocument?.activeElement;
    if (root.contains?.(active)) {
      focusedControl = controlIdentity(active);
      if (focusedControl) rememberScroll(root);
      return;
    }
    if (!active || active === root.ownerDocument?.body) return;
    focusedControl = null;
    scrollPosition = null;
  }

  function matchesIdentity(element, identity) {
    const candidate = controlIdentity(element);
    if (candidate?.kind !== identity.kind) return false;
    if (candidate.pluginId !== identity.pluginId) return false;
    return candidate.capabilityId === identity.capabilityId;
  }

  function restoreScrollPosition() {
    if (!scrollPosition) return;
    if (scrollPosition.viewport.isConnected === false) return;
    scrollPosition.viewport.scrollTop = scrollPosition.top;
  }

  function restoreToolScroll(root) {
    for (const list of root.querySelectorAll("[data-plugin-tools-scroll]")) {
      list.scrollTop = toolScrollPositions.get(list.dataset.pluginToolsScroll) || 0;
    }
  }

  function isCardNavigationFocus() {
    return ["open", "back"].includes(focusedControl?.kind);
  }

  function restore(root, busy) {
    restoreToolScroll(root);
    if (!focusedControl) return;
    if (busy && !isCardNavigationFocus()) return;
    const controls = root.querySelectorAll("[data-plugin-toggle], [data-plugin-capability-toggle], [data-plugin-tools-open], [data-plugin-tools-back], [data-plugin-refresh]");
    let target = [...controls].find((element) => matchesIdentity(element, focusedControl));
    if (target?.disabled) {
      target = [...controls].find((element) => element.dataset.pluginToolsBack === focusedControl.pluginId);
    }
    if (!target || target.closest?.("[inert]")) return;
    if (target.closest?.("[hidden]")) return;
    target.focus?.({ preventScroll: true });
    restoreScrollPosition();
    if (root.ownerDocument?.activeElement !== target) return;
    focusedControl = null;
    scrollPosition = null;
  }

  function changeCardView(root, pluginId, open, onViewChange) {
    capture(root);
    rememberScroll(root);
    if (open) openPluginIds.add(pluginId);
    else openPluginIds.delete(pluginId);
    focusedControl = { kind: open ? "back" : "open", pluginId };
    onViewChange();
  }

  function bind(root, onViewChange) {
    for (const button of root.querySelectorAll("[data-plugin-tools-open]")) {
      button.addEventListener("click", () => changeCardView(root, button.dataset.pluginToolsOpen, true, onViewChange));
    }
    for (const button of root.querySelectorAll("[data-plugin-tools-back]")) {
      button.addEventListener("click", () => changeCardView(root, button.dataset.pluginToolsBack, false, onViewChange));
    }
    for (const panel of root.querySelectorAll("[data-plugin-tools-panel]")) {
      panel.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        changeCardView(root, panel.dataset.pluginToolsPanel, false, onViewChange);
      });
    }
  }

  function reset() {
    openPluginIds.clear();
    toolScrollPositions.clear();
    focusedControl = null;
    scrollPosition = null;
  }

  return { bind, capture, openPluginIds, reset, restore };
}
