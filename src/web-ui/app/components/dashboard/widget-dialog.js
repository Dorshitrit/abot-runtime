/** The original live panel is borrowed temporarily, never rendered a second time. */
export function createHomeWidgetDialog({ root, onClosed }) {
  const documentRoot = root.ownerDocument;
  const dialog = documentRoot.createElement("dialog");
  dialog.className = "home-widget-dialog";
  dialog.setAttribute("aria-labelledby", "home-widget-detail-title");
  dialog.innerHTML = `<header class="home-widget-dialog-header">
    <h2 id="home-widget-detail-title"></h2>
    <button type="button" class="home-text-button" data-home-widget-close aria-label="Close details">Close</button>
  </header><div class="home-widget-dialog-body"></div>`;
  root.appendChild(dialog);
  const title = dialog.querySelector("h2");
  const body = dialog.querySelector(".home-widget-dialog-body");
  const closeButton = dialog.querySelector("[data-home-widget-close]");
  const empty = documentRoot.createElement("p");
  empty.className = "home-panel-state";
  empty.setAttribute("role", "status");
  let borrowed = null;

  function restorePanel() {
    if (!borrowed) return null;
    const previous = borrowed;
    borrowed = null;
    previous.entry.element.classList.remove("home-widget-expanded");
    const parent = previous.entry.getReturnParent?.() || previous.parent;
    const next = previous.nextSibling;
    const anchor = next?.parentNode === parent ? next : null;
    parent.insertBefore(previous.entry.element, anchor);
    empty.remove();
    return previous.entry;
  }

  function close({ restoreFocus = true } = {}) {
    const entry = restorePanel();
    if (dialog.open) dialog.close();
    if (entry) onClosed(entry, restoreFocus);
  }

  function refresh() {
    if (!borrowed) return;
    const summary = borrowed.entry.getSummary();
    empty.textContent = borrowed.entry.emptyMessage || [summary.title, summary.detail].filter(Boolean).join(" · ");
    empty.hidden = !borrowed.entry.element.hidden;
  }

  function open(entry) {
    if (borrowed?.entry === entry) return;
    close({ restoreFocus: false });
    const element = entry.element;
    borrowed = { entry, parent: element.parentNode, nextSibling: element.nextSibling };
    title.textContent = entry.label;
    element.classList.add("home-widget-expanded");
    body.appendChild(element);
    body.appendChild(empty);
    refresh();
    body.scrollTop = 0;
    dialog.showModal();
    closeButton.focus({ preventScroll: true });
  }

  closeButton.addEventListener("click", () => close());
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    const entry = restorePanel();
    if (entry) onClosed(entry, true);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    const inside = event.clientX >= bounds.left && event.clientX <= bounds.right &&
      event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    if (!inside) close();
  });
  return {
    open, close, refresh,
    isExpanded: (element) => borrowed?.entry.element === element,
    dispose() { close({ restoreFocus: false }); dialog.remove(); },
  };
}
