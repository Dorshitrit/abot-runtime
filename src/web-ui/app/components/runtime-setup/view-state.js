export function createSetupViewState(container) {
  let focusIdentity = null;
  let focusIsOutside = false;
  let scrollTop = 0;
  const scroller = () =>
    container.closest?.(".home-workspace-panel") || container;

  function capture() {
    scrollTop = scroller().scrollTop;
    const active = container.ownerDocument?.activeElement;
    if (!active) {
      focusIsOutside = false;
      return;
    }
    const focusIsOnPage =
      active === container.ownerDocument.body ||
      active === container.ownerDocument.documentElement;
    focusIsOutside = !focusIsOnPage && !container.contains?.(active);
    if (focusIsOutside) {
      focusIdentity = null;
      return;
    }
    if (focusIsOnPage) return;
    if (active.dataset?.runtimeSetupField)
      focusIdentity = { field: active.dataset.runtimeSetupField };
    else if (active.dataset?.runtimeSetupAction)
      focusIdentity = { action: active.dataset.runtimeSetupAction };
    else if (active.hasAttribute?.("data-runtime-setup-title"))
      focusIdentity = { title: true };
    else if (active.type === "submit") focusIdentity = { submit: true };
    else focusIdentity = null;
  }

  function restore({ focus = false, busy = false } = {}) {
    scroller().scrollTop = focus ? 0 : scrollTop;
    if (focus && !focusIsOutside) focusIdentity = { title: true };
    if (focusIsOutside || (busy && !focus) || !focusIdentity) return;
    let selector = "[data-runtime-setup-title]";
    if (focusIdentity.field)
      selector = `[data-runtime-setup-field="${focusIdentity.field}"]`;
    if (focusIdentity.action)
      selector = `[data-runtime-setup-action="${focusIdentity.action}"]`;
    if (focusIdentity.submit) selector = '.runtime-setup-action[type="submit"]';
    const target = container.querySelector(selector);
    if (!target?.disabled) target?.focus?.({ preventScroll: true });
  }

  return {
    capture,
    restore,
    canRestoreFocus: () => !focusIsOutside,
    reset: () => {
      focusIdentity = null;
      focusIsOutside = false;
      scrollTop = 0;
    },
  };
}
