export function createProjectGroupActions({ group, disabled, onDeleteProject, documentRoot }) {
  const actions = documentRoot.createElement("div");
  actions.className = "session-actions project-group-actions";
  actions.setAttribute("aria-label", "Project settings");
  const button = documentRoot.createElement("button");
  button.className = "session-menu-button";
  button.type = "button";
  button.disabled = disabled;
  button.title = "Settings for " + group.name;
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  const menuId = "project-actions-" + encodeURIComponent(group.id);
  button.setAttribute("aria-controls", menuId);
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 2h4l.6 3.1 1.8 1 3-.9 2 3.5-2.4 2v2.6l2.4 2-2 3.5-3-.9-1.8 1L14 22h-4l-.6-3.1-1.8-1-3 .9-2-3.5 2.4-2v-2.6l-2.4-2 2-3.5 3 .9 1.8-1Z"/><circle cx="12" cy="12" r="3.4"/></svg>';
  const menu = documentRoot.createElement("div");
  menu.id = menuId;
  menu.className = "session-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const remove = documentRoot.createElement("button");
  remove.className = "session-action delete-action project-delete-action";
  remove.type = "button";
  remove.disabled = disabled;
  remove.setAttribute("role", "menuitem");
  remove.tabIndex = -1;
  remove.textContent = "Delete project";
  remove.addEventListener("click", () => {
    button.focus();
    void onDeleteProject(group.id, group.name);
  });
  menu.appendChild(remove);
  actions.append(button, menu);
  return actions;
}
