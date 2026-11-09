/** Isolate the existing workspace's fixed DOM references when embedded a second time. */
export function scopeManagementIds(root, prefix) {
  const ids = new Map();
  for (const node of root.querySelectorAll("[id]")) {
    const previous = node.getAttribute("id");
    if (!previous) continue;
    const next = `${prefix}-${previous}`;
    ids.set(previous, next);
    node.setAttribute("id", next);
  }
  for (const attribute of ["for", "aria-labelledby", "aria-describedby", "aria-controls"]) {
    for (const node of root.querySelectorAll(`[${attribute}]`)) {
      const references = node.getAttribute(attribute).split(/\s+/);
      node.setAttribute(attribute, references.map((id) => ids.get(id) || id).join(" "));
    }
  }
}

export function closeNestedManagementDialogs(root) {
  for (const dialog of [...root.querySelectorAll("dialog")].reverse()) {
    if (dialog.open) dialog.close();
  }
}

export function restoreManagementFocus(target, documentRoot) {
  if (!target || !documentRoot.body.contains(target)) return;
  if (target.closest("[hidden]") || target.closest("[inert]")) return;
  target.focus({ preventScroll: true });
}
