const settleDuration = 180;
const maximumSettleDistance = 8;

function readLayoutPosition(node) {
  return { left: Number.parseFloat(node.style.left), top: Number.parseFloat(node.style.top) };
}

function canAnimateSettlement(node, before, after) {
  if (node.hidden || typeof node.animate !== "function") return false;
  const distanceX = Math.abs(after.left - before.left);
  const distanceY = Math.abs(after.top - before.top);
  if (!Number.isFinite(distanceX) || !Number.isFinite(distanceY)) return false;
  if (distanceX > maximumSettleDistance || distanceY > maximumSettleDistance) return false;
  return distanceX > 0 || distanceY > 0;
}

/** Decorative release motion never owns the final layout or saved coordinates. */
export function createSparkPlacementMotion(windowRoot) {
  const reducedMotion = windowRoot.matchMedia?.("(prefers-reduced-motion: reduce)");
  const animations = new Set();

  function cancel() {
    for (const animation of animations) animation.cancel();
    animations.clear();
  }

  function animateNode(node, before) {
    const after = readLayoutPosition(node);
    if (!canAnimateSettlement(node, before, after)) return;
    const animation = node.animate([
      { left: `${before.left}px`, top: `${before.top}px` },
      { left: `${after.left}px`, top: `${after.top}px` },
    ], { duration: settleDuration, easing: "cubic-bezier(.2,.8,.2,1)" });
    animations.add(animation);
    animation.onfinish = () => { animations.delete(animation); animation.cancel(); };
  }

  function settle(captured) {
    cancel();
    if (reducedMotion?.matches) return;
    for (const { node, position } of captured) animateNode(node, position);
  }

  function onPreferenceChange() { if (reducedMotion?.matches) cancel(); }
  reducedMotion?.addEventListener?.("change", onPreferenceChange);

  return {
    capture: (nodes) => nodes.filter((node) => !node.hidden).map((node) => ({ node, position: readLayoutPosition(node) })),
    settle, cancel,
    destroy() { cancel(); reducedMotion?.removeEventListener?.("change", onPreferenceChange); },
  };
}
