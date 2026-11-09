export function clampPanelWidth(value, bounds) {
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, value)));
}

export function createPanelWidthResizer({
  handle, panel, viewport, getBounds, isEnabled, applyWidth, restoreWidth,
  captureWidth, edge = "right",
}) {
  if (!handle) return { sync() {}, cancel() {} };
  let drag = null;
  const direction = edge === "right" ? 1 : -1;

  function measuredWidth() {
    return panel.getBoundingClientRect().width;
  }

  function sync() {
    const enabled = isEnabled();
    handle.hidden = !enabled;
    if (!enabled) {
      cancel();
      return;
    }
    const bounds = getBounds();
    handle.setAttribute("aria-valuemin", String(bounds.min));
    handle.setAttribute("aria-valuemax", String(bounds.max));
    handle.setAttribute("aria-valuenow", String(clampPanelWidth(measuredWidth(), bounds)));
  }

  function resizeTo(width) {
    const value = clampPanelWidth(width, getBounds());
    applyWidth(value);
    handle.setAttribute("aria-valuenow", String(value));
  }

  function releaseDrag() {
    const active = drag;
    drag = null;
    handle.classList.remove("is-resizing");
    if (!active) return;
    if (handle.hasPointerCapture?.(active.pointerId)) handle.releasePointerCapture(active.pointerId);
  }

  function cancel() {
    if (!drag) return;
    const previous = drag.previous;
    releaseDrag();
    restoreWidth(previous);
  }

  function canBeginPointerResize(event) {
    if (!isEnabled()) return false;
    if (event.button !== 0) return false;
    if (event.isPrimary === false) return false;
    return Number.isFinite(event.clientX);
  }

  function begin(event) {
    if (!canBeginPointerResize(event)) return;
    cancel();
    drag = {
      pointerId: event.pointerId, x: event.clientX,
      width: measuredWidth(), previous: captureWidth(),
    };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-resizing");
    handle.focus({ preventScroll: true });
    event.preventDefault();
    sync();
  }

  function ownsPointer(event) {
    return drag !== null && event.pointerId === drag.pointerId;
  }

  function move(event) {
    if (!ownsPointer(event)) return;
    if (!isEnabled()) {
      cancel();
      return;
    }
    resizeTo(drag.width + (event.clientX - drag.x) * direction);
    event.preventDefault();
  }

  function finish(event) {
    if (!ownsPointer(event)) return;
    move(event);
    releaseDrag();
    sync();
  }

  function pointerCancelled(event) {
    if (!ownsPointer(event)) return;
    cancel();
    sync();
  }

  function keyWidth(key) {
    const bounds = getBounds();
    if (key === "Home") return bounds.min;
    if (key === "End") return bounds.max;
    if (key === "ArrowLeft") return measuredWidth() - 16 * direction;
    if (key === "ArrowRight") return measuredWidth() + 16 * direction;
    return null;
  }

  function keydown(event) {
    if (event.key === "Escape" && drag) {
      cancel();
      sync();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!isEnabled()) return;
    const width = keyWidth(event.key);
    if (width === null) return;
    cancel();
    resizeTo(width);
    sync();
    event.preventDefault();
    event.stopPropagation();
  }

  handle.addEventListener("pointerdown", begin);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", pointerCancelled);
  handle.addEventListener("lostpointercapture", pointerCancelled);
  handle.addEventListener("keydown", keydown);
  handle.addEventListener("focus", sync);
  viewport.addEventListener?.("blur", () => { cancel(); sync(); });
  viewport.addEventListener?.("resize", sync);
  const observer = typeof viewport.ResizeObserver === "function"
    ? new viewport.ResizeObserver(sync) : null;
  observer?.observe(panel);
  return { sync, cancel };
}
