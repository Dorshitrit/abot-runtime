/** Compact desktop navigation: preserve the original buttons and scroll owner. */
export function createWorkspaceRailScroll({ rail, documentRoot = rail?.ownerDocument, viewport = documentRoot?.defaultView }) {
  const actions = rail?.querySelector(".rail-actions");
  if (!actions || !viewport?.matchMedia) return null;
  const desktop = viewport.matchMedia("(min-width: 761px)");
  const reducedMotion = viewport.matchMedia("(prefers-reduced-motion: reduce)");
  const frame = documentRoot.createElement("div");
  frame.className = "rail-scroll-frame";
  const up = createScrollButton("up", "Scroll navigation up");
  const down = createScrollButton("down", "Scroll navigation down");
  actions.parentElement.insertBefore(frame, actions);
  frame.append(up, actions, down);
  let scheduled = 0;
  let disposed = false;
  let revealSelected = true;
  let lastSelected = null;

  function createScrollButton(direction, label) {
    const button = documentRoot.createElement("button");
    button.type = "button";
    button.className = `rail-scroll-button rail-scroll-${direction}`;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.disabled = true;
    const chevron = documentRoot.createElement("span");
    chevron.setAttribute("aria-hidden", "true");
    button.append(chevron);
    return button;
  }

  function isCompactDesktopRail() {
    if (!desktop.matches) return false;
    return documentRoot.documentElement.dataset.navigation === "icons";
  }

  function revealButton(button) {
    if (!button || button.hidden || !button.getClientRects().length) return;
    const item = button.getBoundingClientRect();
    const view = actions.getBoundingClientRect();
    if (item.top < view.top) {
      actions.scrollTop += item.top - view.top;
      return;
    }
    if (item.bottom > view.bottom) actions.scrollTop += item.bottom - view.bottom;
  }

  function updateEdges(overflowing) {
    const above = overflowing && actions.scrollTop > 1;
    const below = overflowing && actions.scrollTop + actions.clientHeight < actions.scrollHeight - 1;
    const focusedArrow = documentRoot.activeElement;
    up.disabled = !above;
    down.disabled = !below;
    actions.dataset.scrollAbove = String(above);
    actions.dataset.scrollBelow = String(below);
    if (focusedArrow !== up && focusedArrow !== down) return;
    if (!focusedArrow.disabled) return;
    const visibleButtons = Array.from(actions.querySelectorAll(".rail-button"))
      .filter((button) => !button.disabled && !button.hidden && button.getClientRects().length);
    const nextFocus = focusedArrow === up ? visibleButtons[0] : visibleButtons.at(-1);
    nextFocus?.focus({ preventScroll: true });
  }

  function sync() {
    scheduled = 0;
    if (disposed) return;
    if (!isCompactDesktopRail()) {
      delete frame.dataset.railOverflow;
      delete actions.dataset.scrollAbove;
      delete actions.dataset.scrollBelow;
      up.disabled = true;
      down.disabled = true;
      return;
    }
    // Compare against the whole available frame, including reserved arrow slots.
    // Comparing only the reduced viewport would keep arrows after overflow ends.
    const overflowing = actions.scrollHeight > frame.clientHeight + 1;
    frame.dataset.railOverflow = String(overflowing);
    const selected = actions.querySelector('[aria-current="page"]');
    if (revealSelected || selected !== lastSelected) revealButton(selected);
    lastSelected = selected;
    revealSelected = false;
    updateEdges(overflowing);
  }

  function schedule(reveal = false) {
    if (disposed) return;
    revealSelected ||= reveal;
    if (scheduled) return;
    scheduled = viewport.requestAnimationFrame(sync);
  }

  function refresh() { schedule(true); }
  function onScroll() { schedule(); }
  function onFocus(event) {
    if (!isCompactDesktopRail()) return;
    const button = event.target.closest?.(".rail-button");
    if (!actions.contains(button)) return;
    revealButton(button);
    schedule();
  }
  function scrollPage(direction) {
    if (!isCompactDesktopRail()) return;
    actions.scrollBy({
      top: direction * Math.max(44, actions.clientHeight * 0.7),
      behavior: reducedMotion.matches ? "instant" : "smooth",
    });
  }
  const scrollUp = () => scrollPage(-1);
  const scrollDown = () => scrollPage(1);
  up.addEventListener("click", scrollUp);
  down.addEventListener("click", scrollDown);
  actions.addEventListener("scroll", onScroll, { passive: true });
  actions.addEventListener("focusin", onFocus);
  desktop.addEventListener("change", refresh);
  viewport.addEventListener("resize", refresh);
  const resize = new viewport.ResizeObserver(refresh);
  resize.observe(frame);
  resize.observe(actions);
  const mutations = new viewport.MutationObserver(() => schedule());
  mutations.observe(actions, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "aria-current"] });
  const appearance = new viewport.MutationObserver(refresh);
  appearance.observe(documentRoot.documentElement, { attributes: true, attributeFilter: ["data-navigation"] });
  refresh();

  return {
    refresh,
    destroy() {
      disposed = true;
      viewport.cancelAnimationFrame(scheduled);
      resize.disconnect();
      mutations.disconnect();
      appearance.disconnect();
      desktop.removeEventListener("change", refresh);
      viewport.removeEventListener("resize", refresh);
      actions.removeEventListener("scroll", onScroll);
      actions.removeEventListener("focusin", onFocus);
      up.removeEventListener("click", scrollUp);
      down.removeEventListener("click", scrollDown);
      delete actions.dataset.scrollAbove;
      delete actions.dataset.scrollBelow;
      frame.parentElement.insertBefore(actions, frame);
      frame.remove();
    },
  };
}
