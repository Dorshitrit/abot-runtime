import { wrappedIndex } from "../ui-behavior.js";

export function focusSelectedMenuItem(menu, fallback = "first") {
  requestAnimationFrame(() => {
    const items = [...menu.querySelectorAll('[role="menuitemradio"]')];
    const selected = items.find(
      (item) => item.getAttribute("aria-checked") === "true",
    );
    const target =
      selected || (fallback === "last" ? items.at(-1) : items.at(0));
    target?.focus();
  });
}

export function handleMenuNavigation(event, menu) {
  if (
    event.key !== "ArrowDown" &&
    event.key !== "ArrowUp" &&
    event.key !== "Home" &&
    event.key !== "End"
  ) {
    return;
  }
  const items = [...menu.querySelectorAll('[role="menuitemradio"]')];
  if (items.length === 0) return;
  event.preventDefault();
  const currentIndex = items.indexOf(document.activeElement);
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : wrappedIndex(
            currentIndex < 0 ? 0 : currentIndex,
            event.key === "ArrowDown" ? 1 : -1,
            items.length,
          );
  items[nextIndex]?.focus();
}
