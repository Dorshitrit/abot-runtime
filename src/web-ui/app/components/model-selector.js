import { syncChatgptPlanIndicator } from "./chatgpt-plan-indicator.js";
import { groupModelSelectorOptions } from "../lib/model-selector-options.js";
import { renderModelSelectorMenu } from "./model-selector-menu.js";
import { renderSelectedModelLabel } from "./model-selector-label.js";

function modelOptions(select) {
  return [...select.options].map((option) => ({
    value: option.value,
    label: option.label || option.textContent || option.value,
    disabled: option.disabled,
    providerId: option.dataset?.providerId || "",
    providerLabel: option.dataset?.providerLabel || "",
    usingChatgptPlan: option.dataset?.authentication === "chatgpt",
    executionPolicy: option.dataset?.executionPolicy,
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
  let browsedProviderId = null;

  function selectedOption() {
    return modelOptions(select).find((option) => option.value === select.value);
  }

  function setOpen(next, { restoreFocus = false } = {}) {
    open = Boolean(next) && !select.disabled && modelOptions(select).length > 0;
    browsedProviderId = null;
    render({ restoreMenuFocus: false });
    if (open) {
      onOpen();
      focusMenu();
    } else if (restoreFocus) {
      button.focus();
    }
  }

  function focusMenu({ providerId = null, modelId = null, selectorAction = null } = {}) {
    viewport.requestAnimationFrame(() => {
      if (!open) return;
      const items = [...menu.querySelectorAll('[data-selector-item="true"]:not(:disabled)')];
      const action = items.find((item) => item.dataset.selectorAction === selectorAction);
      const provider = items.find((item) => item.dataset.providerId === providerId);
      const model = items.find((item) => item.dataset.modelId === modelId);
      const active = items.find((item) => item.getAttribute("data-selector-active") === "true");
      const firstModel = items.find((item) => item.dataset.modelId);
      (action || model || provider || active || firstModel || items[0])?.focus();
    });
  }

  function browseProvider(providerId) {
    browsedProviderId = providerId;
    render({ restoreMenuFocus: false });
    focusMenu();
  }

  function showProviders() {
    const previousProvider = browsedProviderId;
    browsedProviderId = null;
    render({ restoreMenuFocus: false });
    focusMenu({ providerId: previousProvider });
  }

  function choose(value) {
    const option = modelOptions(select).find((option) => option.value === value);
    if (!option || option.disabled || select.disabled) return;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    setOpen(false, { restoreFocus: true });
  }

  function render({ restoreMenuFocus = true } = {}) {
    const focused = documentRoot.activeElement;
    const hadMenuFocus = open && menu.contains(focused);
    const options = modelOptions(select);
    const groups = groupModelSelectorOptions(options);
    if (!groups.some((group) => group.id === browsedProviderId)) browsedProviderId = null;
    const selected = selectedOption() || options[0] || null;
    syncChatgptPlanIndicator({ anchor: button, documentRoot, usingPlan: selected?.usingChatgptPlan === true });
    button.disabled = select.disabled || options.length === 0;
    if (button.disabled) {
      open = false;
      browsedProviderId = null;
    }
    button.setAttribute("aria-expanded", open ? "true" : "false");
    button.classList.toggle("open", open);
    const label = selected?.label || "No models configured";
    renderSelectedModelLabel({
      valueLabel, button, documentRoot, provider: selected?.providerLabel, model: label,
      executionPolicy: button.disabled ? undefined : selected?.executionPolicy,
    });
    menu.hidden = !open;
    menu.classList.toggle("open", open);
    menu.setAttribute("role", "menu");
    renderModelSelectorMenu({
      menu, groups, providerId: browsedProviderId,
      selectedValue: select.value, documentRoot,
      onBrowse: browseProvider, onBack: showProviders, onChoose: choose,
    });
    if (restoreMenuFocus && hadMenuFocus && open) focusMenu(focused.dataset);
  }

  function moveFocus(event) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    const items = [
      ...menu.querySelectorAll('[data-selector-item="true"]:not(:disabled)'),
    ];
    if (items.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, items.indexOf(documentRoot.activeElement));
    if (event.key === "Home") return items[0]?.focus();
    if (event.key === "End") return items.at(-1)?.focus();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    items[(current + direction + items.length) % items.length]?.focus();
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
