/** Screen-space ellipses shared by the portraits and their orbital guides. */
function orbitLayout(total, width, height) {
  const small = width < 580;
  const radii = total < 2 ? [] : total <= 7 ? [.88] : [.55, 1];
  return {
    width, height, total, small, cx: width / 2, cy: Math.min(height * .49, 400), tilt: -.14,
    tracks: radii.map(ratio => ({
      rx: Math.max(80, width * .42 - 20) * ratio,
      ry: Math.min(height * .28, small ? 210 : 235) * ratio,
    })),
  };
}

function pointOnOrbit(index, elapsed, layout) {
  const { cx, cy, total, small, tilt } = layout;
  if (index === 0) return { x: cx, y: cy, depth: 0, size: small ? 78 : 100 };
  const inner = index <= 6;
  const slot = inner ? index - 1 : (index - 7) % 12;
  const count = inner ? Math.min(6, total - 1) : Math.min(12, total - index + slot);
  const angle = -Math.PI / 2 + .22 + slot / count * Math.PI * 2 + elapsed / (inner ? 900 : 1440) * Math.PI * 2;
  const { rx, ry } = layout.tracks[inner ? 0 : 1];
  const depth = Math.sin(angle), dx = rx * Math.cos(angle), dy = ry * depth;
  // Keep the smallest touch target at 44px while the name stays at its normal text size.
  const size = small ? 54.5 + depth * 10.5 : 75 + depth * 18;
  return { x: cx + dx * Math.cos(tilt) - dy * Math.sin(tilt), y: cy + dx * Math.sin(tilt) + dy * Math.cos(tilt), depth, size };
}

export function agentOrbitPoint(index, total, elapsed, width, height) {
  return pointOnOrbit(index, elapsed, orbitLayout(total, width, height));
}

function positionGuides(guides, layout) {
  guides.forEach((guide, index) => {
    const track = layout.tracks[index];
    guide.hidden = !track;
    if (!track) return;
    guide.style.left = `${layout.cx}px`;
    guide.style.top = `${layout.cy}px`;
    guide.style.width = `${2 * track.rx}px`;
    guide.style.height = `${2 * track.ry}px`;
    guide.style.transform = `translate(-50%, -50%) rotate(${layout.tilt}rad)`;
  });
}
// Include the name, the working ring and the vertical travel of the floating avatar.
function portraitBox(point, scale, label) {
  const half = point.size / 2;
  const radius = Math.max(half + 8, label.width / 2) * scale;
  return {
    left: point.x - radius, right: point.x + radius,
    top: point.y - (half + 13) * scale, bottom: point.y + (half + label.below) * scale,
  };
}

function boxesIntersect(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// Pure geometry: reserve a visible portrait lane above each transient pane.
export function agentWindowPlacement(point, width, height, paneWidth, paneHeight) {
  const bound = (n, lo, hi) => Math.max(lo, Math.min(n, Math.max(lo, hi)));
  const lane = Math.min(180, height * .36);
  return { x: bound(point.x - paneWidth / 2, 0, width - paneWidth),
    y: bound(point.y + 85, lane, height - paneHeight) };
}

export function createAgentOrbitMotion({ field, chat, nodes, guides = [], onLayout, documentRoot = document, viewport = window }) {
  const reduced = viewport.matchMedia?.("(prefers-reduced-motion: reduce)");
  let selected = "", foreground = "", order = [], active = false, raf = 0, last = 0, elapsed = 0;
  let panel = null, label = null, layout = null;
  const approaches = new Map();
  const windowTargets = new Map(), windowReturns = new Map();
  const windowProgress = new Map();
  function windowPoint(id) {
    const index = order.indexOf(id);
    return index < 0 ? null : pointOnOrbit(index, elapsed, orbitLayout(order.length, field.clientWidth || 900, field.clientHeight || 700));
  }
  function setWindowTarget(id, target) {
    if (target) { windowTargets.set(id, { ...target }); windowReturns.delete(id); }
    else if (windowTargets.has(id)) { windowReturns.set(id, windowTargets.get(id)); windowTargets.delete(id); }
    draw(); restart();
  }

  function measureConversation() {
    if (!selected || chat.hidden) return;
    const node = nodes.get(selected);
    if (!node) return;
    const name = node.querySelector(".agents-name");
    label = { width: name.offsetWidth, below: name.offsetTop + name.offsetHeight - node.offsetHeight };
    const left = chat.getBoundingClientRect().left - field.getBoundingClientRect().left;
    panel = { left, right: left + chat.offsetWidth, top: chat.offsetTop, bottom: chat.offsetTop + chat.offsetHeight };
  }

  function draw(dt = 0) {
    const width = field.clientWidth || 900, height = field.clientHeight || 700;
    if (!layout || layout.total !== order.length || layout.width !== width || layout.height !== height) {
      layout = orbitLayout(order.length, width, height);
      positionGuides(guides, layout);
    }
    const step = reduced?.matches ? 1 : Math.min(1, dt / .32);
    const portraits = [];
    for (const [index, id] of order.entries()) {
      const element = nodes.get(id);
      if (!element) continue;
      const target = id === selected ? 1 : 0;
      const old = approaches.get(id) || 0;
      const progress = old + Math.max(-step, Math.min(step, target - old));
      if (progress > 0) approaches.set(id, progress);
      else approaches.delete(id);

      const point = pointOnOrbit(index, elapsed, layout);
      let scale = 1;
      if (progress && panel && label) {
        const mix = progress * progress * (3 - 2 * progress);
        if (index > 0) {
          const focusedSize = layout.small ? 49 : 74;
          point.size += (focusedSize - point.size) * mix;
        }
        const fullHeight = point.size + 13 + label.below;
        const focusScale = Math.min(1.23, (panel.top - 16) / fullHeight);
        const focusY = Math.min(150, height * .21, panel.top - 8 - (point.size / 2 + label.below) * focusScale);
        point.x += (width / 2 - point.x) * mix;
        point.y += (focusY - point.y) * mix;
        scale += (focusScale - 1) * mix;
      }
      const destination = windowTargets.get(id) || windowReturns.get(id);
      if (destination) {
        const oldWindowProgress = windowProgress.get(id) || 0;
        const desired = windowTargets.has(id) ? 1 : 0;
        const p = oldWindowProgress + Math.max(-step, Math.min(step, desired - oldWindowProgress));
        windowProgress.set(id, p);
        const mix = p * p * (3 - 2 * p);
        point.x += (destination.x - point.x) * mix;
        point.y += (destination.y - point.y) * mix;
        point.size += (destination.size - point.size) * mix;
        scale += ((destination.scale ?? 1.15) - scale) * mix;
        if (!p && !windowTargets.has(id)) { windowProgress.delete(id); windowReturns.delete(id); }
      }
      element.style.setProperty("--orbit-x", `${point.x.toFixed(2)}px`);
      element.style.setProperty("--orbit-y", `${point.y.toFixed(2)}px`);
      element.style.setProperty("--orb-size", `${point.size.toFixed(2)}px`);
      element.style.setProperty("--orbit-scale", String(scale));
      element.style.zIndex = id === foreground ? "7" : index === 0 ? "5" : point.depth > 0 ? "3" : "2";
      element.setAttribute("aria-pressed", String(id === selected || windowTargets.has(id)));
      portraits.push({ id, element, point, box: foreground && label ? portraitBox(point, scale, label) : null });
    }

    const focus = approaches.get(foreground) || 0;
    if (!selected && !focus) foreground = "";
    const focused = portraits.find((portrait) => portrait.id === foreground);
    for (const { id, element, box } of portraits) {
      const background = !windowTargets.size && !windowReturns.size && id !== foreground && Boolean(focused?.box);
      const covered = background && (boxesIntersect(box, focused.box) || (selected && boxesIntersect(box, panel)));
      element.style.visibility = covered ? "hidden" : "";
      element.inert = Boolean(covered);
      element.style.opacity = background ? String(1 - .76 * focus) : "1";
    }
    field.dataset.focused = String(Boolean(selected));
    onLayout?.({ width, height, portraits });
  }

  function frame(now) {
    raf = 0; if (!active || documentRoot.hidden) return;
    const dt = last ? Math.min(.05, (now - last) / 1000) : .016; last = now;
    if (!reduced?.matches && !selected && !windowTargets.size && !windowReturns.size) elapsed += dt;
    draw(dt);
    const animating = (!selected && !windowTargets.size) || approaches.get(selected) < 1 || approaches.size > 1 || windowReturns.size || [...windowTargets.keys()].some(id => (windowProgress.get(id) || 0) < 1);
    if (!reduced?.matches && animating) raf = viewport.requestAnimationFrame(frame);
  }
  function restart() { if (active && !raf && !documentRoot.hidden) { last = 0; raf = viewport.requestAnimationFrame(frame); } }
  const visibility = () => { if (documentRoot.hidden) { viewport.cancelAnimationFrame(raf); raf = 0; } else restart(); };
  documentRoot.addEventListener("visibilitychange", visibility);
  const resized = () => { measureConversation(); draw(); restart(); };
  const observer = viewport.ResizeObserver && new viewport.ResizeObserver(resized);
  observer?.observe(field);
  observer?.observe(chat);
  viewport.addEventListener("resize", resized);
  reduced?.addEventListener?.("change", resized);
  return {
    windowPoint, setWindowTarget,
    update(ids) {
      order = ids;
      for (const map of [windowTargets, windowReturns, windowProgress]) for (const id of map.keys()) if (!ids.includes(id)) map.delete(id);
      for (const id of approaches.keys()) if (!nodes.has(id)) approaches.delete(id);
      measureConversation(); draw(); restart();
    },
    select(id) {
      selected = id || "";
      if (selected) foreground = selected;
      measureConversation(); draw(); restart();
    },
    setActive(value) { active = value; if (active) { measureConversation(); restart(); } else { viewport.cancelAnimationFrame(raf); raf = 0; } },
    dispose() { active = false; observer?.disconnect(); viewport.cancelAnimationFrame(raf); documentRoot.removeEventListener("visibilitychange", visibility); viewport.removeEventListener("resize", resized); reduced?.removeEventListener?.("change", resized); },
  };
}
