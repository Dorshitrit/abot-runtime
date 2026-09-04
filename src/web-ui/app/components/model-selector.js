function modelOptions(select) {
  return [...select.options].map((option) => ({
    value: option.value,
    label: option.label || option.textContent || option.value,
    disabled: option.disabled,
  }));
}

export function createModelSelector({
  select,
  button,
  valueLabel,
  menu,
  documentRoot = document,
  viewport = window,
  onOpen = () => {},
}) {
  let open = false;
  let bound = false;

  function selectedOption() {
    return modelOptions(select).find((option) => option.value === select.value);
  }

  function setOpen(next, { restoreFocus = false } = {}) {
    open = Boolean(next) && !select.disabled && modelOptions(select).length > 0;
    render();
    if (open) {
      onOpen();
      viewport.requestAnimationFrame(() => {
        menu
          .querySelector('[role="menuitemradio"][aria-checked="true"]')
          ?.focus();
      });
    } else if (restoreFocus) {
      button.focus();
    }
  }

  function choose(value) {
    if (!modelOptions(select).some((option) => option.value === value)) return;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    setOpen(false, { restoreFocus: true });
  }

  function render() {
    const options = modelOptions(select);
    const selected = selectedOption() || options[0] || null;
    button.disabled = select.disabled || options.length === 0;
    button.setAttribute("aria-expanded", open ? "true" : "false");
    button.classList.toggle("open", open);
    const label = selected?.label || "No models configured";
    valueLabel.textContent = label;
    button.title = `Model: ${label}`;
    button.setAttribute("aria-label", `Model: ${label}`);
    menu.hidden = !open;
    menu.classList.toggle("open", open);
    menu.setAttribute("role", "menu");
    menu.replaceChildren();
    for (const option of options) {
      const item = documentRoot.createElement("button");
      const active = option.value === select.value;
      item.type = "button";
      item.className = `model-select-option${active ? " selected" : ""}`;
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", active ? "true" : "false");
      item.tabIndex = active ? 0 : -1;
      item.disabled = option.disabled;
      item.dataset.modelId = option.value;

      const label = documentRoot.createElement("span");
      label.className = "model-select-option-label";
      label.textContent = option.label;
      const check = documentRoot.createElement("span");
      check.className = "model-select-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = active ? "✓" : "";
      item.append(label, check);
      item.addEventListener("click", () => choose(option.value));
      menu.appendChild(item);
    }
  }

  function moveFocus(event) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    const items = [
      ...menu.querySelectorAll('[role="menuitemradio"]:not(:disabled)'),
    ];
    if (items.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, items.indexOf(documentRoot.activeElement));
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  }

  function bind() {
    if (bound) return;
    bound = true;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      setOpen(!open);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      setOpen(true);
    });
    menu.addEventListener("click", (event) => event.stopPropagation());
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false, { restoreFocus: true });
        return;
      }
      moveFocus(event);
    });
    select.addEventListener("change", render);
    documentRoot.addEventListener("click", (event) => {
      if (
        !open ||
        button.contains(event.target) ||
        menu.contains(event.target)
      ) {
        return;
      }
      setOpen(false);
    });
    render();
  }

  return {
    bind,
    close: () => setOpen(false),
    sync: render,
  };
}
