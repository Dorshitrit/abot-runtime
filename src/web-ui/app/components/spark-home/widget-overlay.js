import { SYSTEM_WIDGET_HEIGHTS, SYSTEM_WIDGET_LIMIT } from "../system-widgets/cards.js";

function hasValidWidgetInstanceId(value) {
  if (typeof value !== "string" || !/^home-widget-[1-9]\d*$/.test(value)) return false;
  return Number(value.slice("home-widget-".length)) <= SYSTEM_WIDGET_LIMIT;
}

function hasValidWidgetRectangle(rect) {
  if (!rect || typeof rect !== "object") return false;
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return false;
  if (Math.abs(rect.x) > 1_000_000 || Math.abs(rect.y) > 1_000_000) return false;
  if (rect.width < 0 || rect.width > 8192) return false;
  return rect.height >= 0 && rect.height <= 600;
}
export function captureHomeWidgetLayout(data, revision) {
  if (data?.kind !== "abot.spark-home-widgets" || data.version !== 1 || data.revision !== revision) return null;
  if (!Array.isArray(data.slots) || data.slots.length > SYSTEM_WIDGET_LIMIT) return null;
  const instances = new Set(); const widgets = new Set(); const slots = [];
  for (const slot of data.slots) {
    if (typeof slot?.instanceId !== "string" || typeof slot.widgetId !== "string") return null;
    if (!hasValidWidgetInstanceId(slot.instanceId) || !Object.hasOwn(SYSTEM_WIDGET_HEIGHTS, slot.widgetId)) return null;
    if (instances.has(slot.instanceId) || widgets.has(slot.widgetId)) return null;
    if (slot.rect !== null && !hasValidWidgetRectangle(slot.rect)) return null;
    instances.add(slot.instanceId); widgets.add(slot.widgetId);
    slots.push({ instanceId: slot.instanceId, widgetId: slot.widgetId,
      rect: slot.rect === null ? null : { x: slot.rect.x, y: slot.rect.y, width: slot.rect.width, height: slot.rect.height } });
  }
  return slots;
}

/** Layout-only adapter. Native widgets remain outside both opaque-origin canvas frames. */
export function createSparkHomeWidgetOverlay({ host, widgets, documentRoot = host.ownerDocument,
  windowRoot = documentRoot.defaultView || globalThis.window }) {
  const layer = documentRoot.createElement("div"); layer.className = "spark-home-widget-overlay";
  let frame; let revision; let environmentId; let enabled = false;
  const entries = new Map();
  function clear() {
    for (const entry of entries.values()) entry.view.dispose();
    entries.clear(); layer.replaceChildren();
  }
  function sendSizes() {
    if (!frame?.contentWindow) return;
    frame.contentWindow.postMessage({ kind: "abot.spark-home-widget-sizing", version: 1, revision,
      sizes: [...entries].map(([instanceId, entry]) => ({ instanceId, height: entry.height })) }, "*");
  }
  function applyLayout(slots) {
    const keep = new Set(slots.map(slot => slot.instanceId));
    for (const [id, entry] of entries) {
      if (keep.has(id)) continue;
      entry.view.dispose(); entry.root.remove(); entries.delete(id);
    }
    for (const slot of slots) {
      let entry = entries.get(slot.instanceId);
      if (entry && entry.id !== slot.widgetId) { entry.view.dispose(); entry.root.remove(); entries.delete(slot.instanceId); entry = null; }
      if (!entry) {
        const root = documentRoot.createElement("div"); root.className = "spark-home-native-widget"; root.hidden = true;
        layer.appendChild(root);
        entry = { root, id: slot.widgetId, height: SYSTEM_WIDGET_HEIGHTS[slot.widgetId], view: { dispose() {} } };
        entries.set(slot.instanceId, entry);
        const current = entry;
        entry.view = widgets.mount(root, slot.widgetId, height => { current.height = height; sendSizes(); });
      }
      const rect = slot.rect;
      entry.root.hidden = !rect || rect.width === 0 || rect.height === 0 || entry.height === 0;
      entry.view.setVisible?.(!entry.root.hidden);
      if (!rect) continue;
      entry.root.style.setProperty("left", `${rect.x}px`); entry.root.style.setProperty("top", `${rect.y}px`);
      entry.root.style.setProperty("width", `${rect.width}px`); entry.root.style.setProperty("height", `${Math.min(rect.height, entry.height)}px`);
    }
  }
  function receive(event) {
    if (!frame?.contentWindow || event.source !== frame.contentWindow) return;
    const slots = captureHomeWidgetLayout(event.data, revision);
    if (slots) applyLayout(slots);
  }
  windowRoot?.addEventListener("message", receive);
  return {
    bind(nextFrame, state) {
      if (frame !== nextFrame || revision !== state.screen?.revision || environmentId !== state.environmentId) {
        clear(); frame = nextFrame; revision = state.screen?.revision; environmentId = state.environmentId;
      }
      if (nextFrame && layer.parentElement !== host) host.appendChild(layer);
      enabled = state.workspaceActive !== false && state.mode === "spark" && Boolean(state.screen) && state.configured !== false && !state.generationPhase;
      layer.hidden = !enabled;
      widgets.setActive(enabled);
    },
    destroy() { windowRoot?.removeEventListener("message", receive); clear(); layer.remove(); },
  };
}
