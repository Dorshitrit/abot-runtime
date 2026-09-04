import { wrappedIndex } from "../ui-behavior.js";
import { textOf } from "../lib/text-format.js";

export function createOperationsSection({ buttons, pages }) {
  const availableTabs = new Set(
    buttons.map((button) => textOf(button.dataset.tab)),
  );

  function activateTab(tabName) {
    const normalized = textOf(tabName, "runtime") || "runtime";
    const nextTab = availableTabs.has(normalized) ? normalized : "runtime";
    for (const button of buttons) {
      const active = button.dataset.tab === nextTab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
    }
    for (const page of pages) {
      const active = page.id === `${nextTab}Tab`;
      page.classList.toggle("active", active);
      page.hidden = !active;
      page.inert = !active;
    }
  }

  function navigateTab(event, button) {
    const isArrowNavigation =
      event.key === "ArrowLeft" || event.key === "ArrowRight";
    if (!isArrowNavigation) return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next =
      buttons[wrappedIndex(buttons.indexOf(button), delta, buttons.length)];
    next?.focus();
    activateTab(next?.dataset.tab);
  }

  function bind() {
    for (const button of buttons) {
      button.addEventListener("click", () => activateTab(button.dataset.tab));
      button.addEventListener("keydown", (event) => navigateTab(event, button));
    }
  }

  return { activateTab, bind };
}
