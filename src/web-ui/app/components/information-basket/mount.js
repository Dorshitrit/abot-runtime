export function mountInformationBasketWorkspace(dom, documentRoot = document) {
  const button = documentRoot.createElement("button");
  button.id = "resourcesWorkspaceButton";
  button.className = "rail-button";
  button.type = "button";
  button.setAttribute("aria-label", "Open Resources");
  button.setAttribute("aria-controls", "resourcesWorkspacePanel");
  button.title = "Resources";
  button.innerHTML = `<span class="rail-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 8h18v13H3zM2 3h20v5H2zm7 9h6" /></svg></span><span class="rail-button-label">Resources</span>`;
  dom.memoryWorkspaceButton.before(button);
  const panel = documentRoot.createElement("section");
  panel.id = "resourcesWorkspacePanel";
  panel.className = "workspace-page-panel information-basket-panel";
  panel.hidden = true;
  panel.inert = true;
  panel.setAttribute("aria-hidden", "true");
  panel.setAttribute("aria-labelledby", "resourcesWorkspaceTitle");
  panel.innerHTML = `<header class="workspace-page-header"><div class="workspace-page-heading"><h2 id="resourcesWorkspaceTitle">Resources</h2></div><button type="button" class="workspace-page-back" data-basket-close>Back to chat</button></header><div class="workspace-page-body" data-basket-root></div>`;
  dom.app.append(panel);
  Object.assign(dom, { resourcesWorkspaceButton: button, resourcesWorkspacePanel: panel,
    closeResourcesWorkspaceButton: panel.querySelector("[data-basket-close]"), resourcesRoot: panel.querySelector("[data-basket-root]") });
}
