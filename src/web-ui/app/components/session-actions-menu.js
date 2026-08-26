function menuItems(actions) {
  return [
    ...actions.querySelectorAll(
      '.session-menu [role="menuitem"]:not(:disabled)',
    ),
  ];
}

export function nextSessionActionIndex(current, key, length) {
  if (length <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  const start = current >= 0 ? current : 0;
  return (start + (key === "ArrowDown" ? 1 : -1) + length) % length;
}

export function createSessionActionsMenu({
  container,
  documentRoot = document,
  viewport = window,
}) {
  let openActions = null;
  let bound = false;

  function close({ restoreFocus = false } = {}) {
    if (!openActions) return;
    const actions = openActions;
    openActions = null;
    actions.classList.remove("open");
    const button = actions.querySelector(".session-menu-button");
    const menu = actions.querySelector(".session-menu");
    button?.setAttribute("aria-expanded", "false");
    if (menu) menu.hidden = true;
    if (restoreFocus) button?.focus();
  }

  function open(actions, focus = "first") {
    if (openActions !== actions) close();
    openActions = actions;
    actions.classList.add("open");
    const button = actions.querySelector(".session-menu-button");
    const menu = actions.querySelector(".session-menu");
    button?.setAttribute("aria-expanded", "true");
    if (menu) menu.hidden = false;
    viewport.requestAnimationFrame(() => {
      const items = menuItems(actions);
      (focus === "last" ? items.at(-1) : items[0])?.focus();
    });
  }

  function toggle(actions) {
    if (openActions === actions) {
      close({ restoreFocus: true });
    } else {
      open(actions);
    }
  }

  function moveFocus(event, actions) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    const items = menuItems(actions);
    if (items.length === 0) return;
    event.preventDefault();
    const next = nextSessionActionIndex(
      items.indexOf(documentRoot.activeElement),
      event.key,
      items.length,
    );
    items[next]?.focus();
  }

  function bind() {
    if (bound) return;
    bound = true;
    container.addEventListener("click", (event) => {
      const button = event.target.closest?.(".session-menu-button");
      if (button && container.contains(button)) {
        event.preventDefault();
        event.stopPropagation();
        const actions = button.closest(".session-actions");
        if (actions) toggle(actions);
        return;
      }
      const action = event.target.closest?.(".session-action");
      if (action && openActions?.contains(action)) close();
    });
    container.addEventListener("keydown", (event) => {
      const button = event.target.closest?.(".session-menu-button");
      if (button && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        const actions = button.closest(".session-actions");
        if (actions) open(actions, event.key === "ArrowUp" ? "last" : "first");
        return;
      }
      const actions = event.target.closest?.(".session-actions");
      if (!actions || actions !== openActions) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close({ restoreFocus: true });
        return;
      }
      moveFocus(event, actions);
    });
    container.addEventListener("focusout", (event) => {
      if (openActions && !openActions.contains(event.relatedTarget)) close();
    });
    documentRoot.addEventListener("click", (event) => {
      if (openActions && !openActions.contains(event.target)) close();
    });
  }

  return {
    bind,
    close,
    reset: () => {
      openActions = null;
    },
  };
}
