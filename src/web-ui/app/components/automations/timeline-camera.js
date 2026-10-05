const MIN_ZOOM = 0.65;
const MAX_ZOOM = 2;
const WHEEL_SENSITIVITY = 0.0015;
const KEYBOARD_ZOOM_STEP = 1.2;
const PAN_BLOCKED_SELECTORS = [
  "button", "input", "textarea", "select", "option", "label", "a", "summary",
  "[draggable]", "[contenteditable]", ".automation-inline-inspector-frame",
];

function boundedZoom(value) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export function wheelZoomLevel(currentZoom, deltaY, deltaMode = 0, viewportHeight = 600) {
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? viewportHeight : 1;
  const movement = Math.max(-60, Math.min(60, deltaY * unit));
  return boundedZoom(currentZoom * Math.exp(-movement * WHEEL_SENSITIVITY));
}

export function canPanFromCanvasTarget(target) {
  return !PAN_BLOCKED_SELECTORS.some((selector) => target.closest(selector));
}

export function createAutomationTimelineCamera(root, { isEditing } = {}) {
  let zoom = 1;
  let scrollLeft = 0;
  let scrollTop = 0;
  let sceneWidth = 800;
  let hasPosition = false;
  const branchScroll = new Map();
  let pan = null;

  function elements() {
    return {
      viewport: root.querySelector("[data-camera-viewport]"),
      scene: root.querySelector("[data-camera-scene]"),
    };
  }

  function hasOpenStepEditor() {
    if (isEditing) return isEditing();
    return Boolean(root.querySelector(".automation-inline-inspector-frame"));
  }

  function updateLevel() {
    const label = root.querySelector("[data-camera-level]");
    if (label) label.textContent = `${Math.round(zoom * 100)}%`;
  }

  function setSceneZoom(scene) {
    scene.setAttribute("style", `width:${sceneWidth}px;zoom:${zoom}`);
    updateLevel();
  }

  function capture() {
    const { viewport } = elements();
    if (!viewport) return;
    scrollLeft = viewport.scrollLeft || 0;
    scrollTop = viewport.scrollTop || 0;
    hasPosition = true;
    branchScroll.clear();
    for (const branch of root.querySelectorAll("[data-branches-for]"))
      branchScroll.set(branch.dataset.branchesFor, { left: branch.scrollLeft || 0, top: branch.scrollTop || 0 });
  }

  function restore() {
    const { viewport, scene } = elements();
    if (!viewport || !scene) return;
    const fittedWidth = Math.min(800, viewport.clientWidth || viewport.getBoundingClientRect?.().width || 800);
    const nextWidth = Math.max(Number(scene.dataset.sceneMinWidth) || 0, fittedWidth);
    if (hasPosition) scrollLeft = Math.max(0, scrollLeft + (nextWidth - sceneWidth) * zoom / 2);
    sceneWidth = nextWidth;
    setSceneZoom(scene);
    if (!hasPosition) scrollLeft = Math.max(0, (sceneWidth * zoom - viewport.clientWidth) / 2);
    viewport.scrollLeft = scrollLeft;
    viewport.scrollTop = scrollTop;
    hasPosition = true;
    for (const branch of root.querySelectorAll("[data-branches-for]")) {
      const position = branchScroll.get(branch.dataset.branchesFor);
      if (!position) continue;
      branch.scrollLeft = position.left;
      branch.scrollTop = position.top;
    }
  }

  function revealNode(nodeId) {
    const { viewport } = elements();
    if (!viewport || !nodeId) return;
    const node = [...root.querySelectorAll("[data-automation-node]")]
      .find((candidate) => candidate.dataset.automationNode === nodeId);
    const item = node?.closest("[data-graph-item]");
    if (!item?.getBoundingClientRect) return;
    for (let parent = item.parentElement; parent && viewport.contains(parent); parent = parent.parentElement) {
      if (parent !== viewport && !parent.matches("[data-branches-for]")) continue;
      const bounds = parent.getBoundingClientRect();
      const itemBounds = item.getBoundingClientRect();
      const scale = bounds.width / (parent.clientWidth || bounds.width || 1);
      const margin = Math.min(8, Math.max(0, (bounds.width - itemBounds.width) / 2));
      const visibleLeft = bounds.left + margin;
      const visibleRight = bounds.right - margin;
      let movement = 0;
      if (itemBounds.width > visibleRight - visibleLeft) movement = itemBounds.left - bounds.left;
      else if (itemBounds.left < visibleLeft) movement = itemBounds.left - visibleLeft;
      else if (itemBounds.right > visibleRight) movement = itemBounds.right - visibleRight;
      if (movement) parent.scrollLeft += movement / scale;
    }
    capture();
  }

  function resetState() {
    pan = null;
    zoom = 1;
    scrollLeft = 0;
    scrollTop = 0;
    hasPosition = false;
    branchScroll.clear();
  }

  function zoomAt(nextZoom, clientX, clientY) {
    const { viewport, scene } = elements();
    if (!viewport || !scene) return false;
    const bounded = boundedZoom(nextZoom);
    if (Math.abs(bounded - zoom) < 0.001) return false;
    if (hasOpenStepEditor()) return false;
    const bounds = viewport.getBoundingClientRect();
    const pointerX = Math.max(0, Math.min(clientX - bounds.left, viewport.clientWidth || bounds.width));
    const pointerY = Math.max(0, Math.min(clientY - bounds.top, viewport.clientHeight || bounds.height));
    const worldX = ((viewport.scrollLeft || 0) + pointerX) / zoom;
    const worldY = ((viewport.scrollTop || 0) + pointerY) / zoom;
    zoom = bounded;
    setSceneZoom(scene);
    viewport.scrollLeft = Math.max(0, worldX * zoom - pointerX);
    viewport.scrollTop = Math.max(0, worldY * zoom - pointerY);
    capture();
    return true;
  }

  function wheel(event) {
    const { viewport } = elements();
    if (!viewport || !Number.isFinite(event.deltaY) || event.deltaY === 0) return false;
    const height = viewport.clientHeight || viewport.getBoundingClientRect().height;
    return zoomAt(wheelZoomLevel(zoom, event.deltaY, event.deltaMode, height), event.clientX, event.clientY);
  }

  function zoomBy(factor) {
    const { viewport } = elements();
    if (!viewport) return false;
    const bounds = viewport.getBoundingClientRect();
    return zoomAt(zoom * factor, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
  }

  function reset() {
    const { viewport, scene } = elements();
    if (!viewport || !scene) return false;
    if (hasOpenStepEditor()) return false;
    zoom = 1;
    setSceneZoom(scene);
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    for (const branch of root.querySelectorAll("[data-branches-for]")) {
      branch.scrollLeft = 0;
      branch.scrollTop = 0;
    }
    capture();
    return true;
  }

  function keyboard(event) {
    if (["+", "="].includes(event.key)) return zoomBy(KEYBOARD_ZOOM_STEP);
    if (event.key === "-") return zoomBy(1 / KEYBOARD_ZOOM_STEP);
    if (event.key === "0") return reset();
    return false;
  }

  function scrollableAncestor(target, viewport, axis) {
    for (let current = target; current && viewport.contains(current); current = current.parentElement) {
      if (current === viewport) return viewport;
      if (!current.matches("[data-branches-for]")) continue;
      const overflow = axis === "x"
        ? current.scrollWidth - current.clientWidth
        : current.scrollHeight - current.clientHeight;
      if (overflow > 1) return current;
    }
    return viewport;
  }

  function startPan(event) {
    const { viewport } = elements();
    if (!viewport?.contains(event.target) || !canPanFromCanvasTarget(event.target)) return false;
    if (event.pointerType === "touch" || (event.button !== undefined && event.button !== 0)) return false;
    const xTarget = scrollableAncestor(event.target, viewport, "x");
    const yTarget = scrollableAncestor(event.target, viewport, "y");
    pan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      xTarget, yTarget, left: xTarget.scrollLeft || 0, top: yTarget.scrollTop || 0 };
    viewport.focus?.({ preventScroll: true });
    viewport.setPointerCapture?.(event.pointerId);
    viewport.dataset.panning = "true";
    return true;
  }

  function movePan(event) {
    if (!pan || event.pointerId !== pan.pointerId) return false;
    pan.xTarget.scrollLeft = pan.left - (event.clientX - pan.x);
    pan.yTarget.scrollTop = pan.top - (event.clientY - pan.y);
    capture();
    return true;
  }

  function endPan(event) {
    if (!pan || event.pointerId !== pan.pointerId) return false;
    const { viewport } = elements();
    if (viewport?.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    viewport?.removeAttribute("data-panning");
    pan = null;
    return true;
  }

  return { capture, restore, revealNode, resetState, wheel, keyboard, reset, startPan, movePan, endPan };
}
