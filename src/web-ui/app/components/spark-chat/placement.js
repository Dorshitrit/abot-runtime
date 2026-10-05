import { createSparkPlacementMotion } from "./motion.js";

const storageKey = "abot.spark.launcher.position.v1";
const margin = 12;
const dragThreshold = 5;
const positionGrid = 16;

function readBrowserStorage(windowRoot) {
  try { return windowRoot.localStorage; } catch { return null; }
}

function readPosition(storage) {
  try {
    const value = JSON.parse(storage?.getItem(storageKey) ?? "null");
    return value && Number.isFinite(value.x) && Number.isFinite(value.y)
      ? { x: value.x, y: value.y } : null;
  } catch { return null; }
}

function clamp(value, size, available) {
  return Math.max(margin, Math.min(value, Math.max(margin, available - size - margin)));
}

function popupOpensAbove(desiredHeight, above, below) {
  if (above >= desiredHeight) return true;
  if (below >= desiredHeight) return false;
  return above >= below;
}

function hasMovedPastDragThreshold(pointer, event) {
  return Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >= dragThreshold;
}

/** Browser-only launcher placement; conversation and environment state stay untouched. */
export function createSparkChatPlacement({ root, launcher, panel, notice, dockAnchor, storage, windowRoot = window }) {
  const positionStorage = storage === undefined ? readBrowserStorage(windowRoot) : storage;
  let position = readPosition(positionStorage);
  let pointer = null;
  let suppressClick = false;
  let suppressionTimer;
  const documentRoot = root.ownerDocument;
  const motion = createSparkPlacementMotion(windowRoot);

  function persist() {
    try {
      if (position) positionStorage?.setItem(storageKey, JSON.stringify(position));
      else positionStorage?.removeItem(storageKey);
    } catch { /* Placement remains usable when browser storage is unavailable. */ }
  }

  function placePopup(node, anchor) {
    Object.assign(node.style, { height: "", maxHeight: "", minHeight: "" });
    const rect = node.getBoundingClientRect();
    const width = node.offsetWidth || rect.width || (node === panel ? 390 : 260);
    const desiredHeight = node.offsetHeight || rect.height || (node === panel ? 560 : 90);
    const above = Math.max(0, anchor.top - margin * 2);
    const below = Math.max(0, windowRoot.innerHeight - anchor.bottom - margin * 2);
    const opensAbove = popupOpensAbove(desiredHeight, above, below);
    const available = opensAbove ? above : below;
    const height = Math.min(desiredHeight, available);
    const top = opensAbove ? anchor.top - margin - height : anchor.bottom + margin;
    const left = clamp(anchor.left, width, windowRoot.innerWidth);
    const originX = Math.max(0, Math.min(width, anchor.left + anchor.width / 2 - left));
    node.style.setProperty?.("--spark-open-shift", opensAbove ? "10px" : "-10px");
    Object.assign(node.style, {
      position: "fixed", right: "auto", bottom: "auto",
      left: `${left}px`, top: `${top}px`,
      minHeight: "0px", maxHeight: `${available}px`,
      transformOrigin: `${originX}px ${opensAbove ? "bottom" : "top"}`,
    });
    if (node === panel) node.style.height = `${height}px`;
  }

  function attachLauncher(parent) {
    if (launcher.parentNode !== parent) parent.append(launcher);
  }

  function applyFloatingPosition() {
    attachLauncher(documentRoot.body);
    launcher.classList.add("spark-launcher-floating");
    const rect = launcher.getBoundingClientRect();
    position = { x: clamp(position.x, rect.width || 60, windowRoot.innerWidth), y: clamp(position.y, rect.height || 60, windowRoot.innerHeight) };
    Object.assign(launcher.style, { position: "fixed", left: `${position.x}px`, top: `${position.y}px` });
  }

  function applyDockedPosition() {
    attachLauncher(dockAnchor);
    launcher.classList.remove("spark-launcher-floating");
    Object.assign(launcher.style, { position: "", left: "", top: "" });
  }

  function refresh() {
    motion.cancel();
    const hadLauncherFocus = documentRoot.activeElement === launcher;
    if (position) applyFloatingPosition();
    else applyDockedPosition();
    const anchor = launcher.getBoundingClientRect();
    placePopup(panel, anchor);
    placePopup(notice, anchor);
    if (hadLauncherFocus && documentRoot.activeElement !== launcher) launcher.focus({ preventScroll: true });
  }

  function reset() {
    pointer = null;
    position = null;
    launcher.classList.remove("spark-launcher-dragging");
    persist(); refresh();
  }

  function onPointerDown(event) {
    if (event.button !== 0 || event.isPrimary === false) return;
    motion.cancel();
    suppressClick = false;
    const rect = launcher.getBoundingClientRect();
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, rect, dragging: false };
  }

  function beginDrag() {
    pointer.dragging = true;
    position = { x: pointer.rect.left, y: pointer.rect.top };
    refresh();
    const rect = launcher.getBoundingClientRect();
    pointer.offsetX = (pointer.x - pointer.rect.left) / Math.max(1, pointer.rect.width) * rect.width;
    pointer.offsetY = (pointer.y - pointer.rect.top) / Math.max(1, pointer.rect.height) * rect.height;
    launcher.classList.add("spark-launcher-dragging");
    launcher.setPointerCapture?.(pointer.id);
  }

  function onPointerMove(event) {
    if (!pointer || event.pointerId !== pointer.id) return;
    const pendingDrag = !pointer.dragging;
    if (pendingDrag && !hasMovedPastDragThreshold(pointer, event)) return;
    if (pendingDrag) beginDrag();
    event.preventDefault();
    position = { x: event.clientX - pointer.offsetX, y: event.clientY - pointer.offsetY };
    refresh();
  }

  function finishPointer(event) {
    if (!pointer || event.pointerId !== pointer.id) return;
    const dragged = pointer.dragging;
    if (launcher.hasPointerCapture?.(pointer.id)) launcher.releasePointerCapture(pointer.id);
    pointer = null;
    launcher.classList.remove("spark-launcher-dragging");
    if (!dragged) return;
    const captured = motion.capture([launcher, panel, notice]);
    position = { x: Math.round(position.x / positionGrid) * positionGrid, y: Math.round(position.y / positionGrid) * positionGrid };
    refresh();
    persist();
    motion.settle(captured);
    suppressClick = true;
    windowRoot.clearTimeout(suppressionTimer);
    suppressionTimer = windowRoot.setTimeout(() => { suppressClick = false; }, 0);
  }

  function onClick(event) {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault(); event.stopImmediatePropagation();
  }

  function onKeyDown(event) {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Home") { event.preventDefault(); reset(); return; }
    const step = event.shiftKey ? 48 : 16;
    const movement = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!movement) return;
    event.preventDefault();
    const rect = launcher.getBoundingClientRect();
    position = { x: rect.left + movement[0], y: rect.top + movement[1] };
    refresh(); persist();
  }

  function onResize() { refresh(); if (position) persist(); }
  launcher.addEventListener("pointerdown", onPointerDown);
  launcher.addEventListener("click", onClick, true);
  launcher.addEventListener("keydown", onKeyDown);
  windowRoot.addEventListener("pointermove", onPointerMove, { passive: false });
  windowRoot.addEventListener("pointerup", finishPointer);
  windowRoot.addEventListener("pointercancel", finishPointer);
  windowRoot.addEventListener("resize", onResize);
  refresh();

  return {
    reset, refresh, isDocked: () => position === null,
    destroy() {
      motion.destroy();
      windowRoot.clearTimeout(suppressionTimer);
      launcher.removeEventListener("pointerdown", onPointerDown);
      launcher.removeEventListener("click", onClick, true);
      launcher.removeEventListener("keydown", onKeyDown);
      windowRoot.removeEventListener("pointermove", onPointerMove);
      windowRoot.removeEventListener("pointerup", finishPointer);
      windowRoot.removeEventListener("pointercancel", finishPointer);
      windowRoot.removeEventListener("resize", onResize);
    },
  };
}
