import { createPanelWidthResizer } from "./panel-width-resizer.js";

function widthState(root, property) {
  return {
    applyWidth: (width) => root.style.setProperty(property, `${width}px`),
    captureWidth: () => root.style.getPropertyValue(property),
    restoreWidth(value) {
      if (value) root.style.setProperty(property, value);
      else root.style.removeProperty(property);
    },
  };
}

export function createConversationSidebarResizing({ dom, viewport }) {
  const panel = dom.sessionsPanel;
  const handle = panel.querySelector?.(".conversation-panel-resize");
  return createPanelWidthResizer({
    handle, panel, viewport,
    ...widthState(dom.app, "--sessions-panel-width"),
    isEnabled: () => !panel.hidden && dom.app.classList.contains("sessions-docked"),
    getBounds: () => ({ min: 220, max: 480 }),
  });
}

export function createProjectChangesResizing({ host, panel, documentRoot, viewport }) {
  const handle = documentRoot.createElement("div");
  handle.className = "conversation-panel-resize project-changes-resize";
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", "Resize project changes");
  panel.appendChild(handle);
  const wide = viewport.matchMedia?.("(min-width: 1201px)");
  const resizer = createPanelWidthResizer({
    handle, panel, viewport, edge: "left",
    ...widthState(host, "--project-changes-panel-width"),
    isEnabled: () => !panel.hidden && wide?.matches === true,
    getBounds: () => ({
      min: 340,
      max: Math.max(340, Math.min(720, host.getBoundingClientRect().width - 360)),
    }),
  });
  wide?.addEventListener("change", resizer.sync);
  return resizer;
}
