import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only layout adapter.
import { captureHomeWidgetLayout, createSparkHomeWidgetOverlay } from "../../web-ui/app/components/spark-home/widget-overlay.js";
import { ContextElement } from "./support/composer-context-window-dom.js";
import { SPARK_HOME_WIDGET_CATALOG } from "../spark-home/widgets/catalog.js";

class OverlayElement extends ContextElement {
  remove() {
    if (!this.parentElement) return;
    const children = this.parentElement.children;
    children.splice(children.indexOf(this), 1); this.parentElement = null;
  }
}
const rect = { x: -8, y: 25, width: 320, height: 600 };
const layout = (changes = {}) => ({ kind: "abot.spark-home-widgets", version: 1, revision: 7,
  slots: [{ instanceId: "home-widget-1", widgetId: "memory-candidates", rect }], ...changes });
const state = { screen: { revision: 7 }, environmentId: "dev", workspaceActive: true, configured: true, mode: "spark" };
function fixture() {
  const documentRoot = { createElement: (tag: string) => new OverlayElement(tag) };
  const host = new OverlayElement("main");
  const windowRoot = new EventTarget();
  const frame = { contentWindow: { postMessage: vi.fn() } };
  const disposals: ReturnType<typeof vi.fn>[] = [];
  const visibility: ReturnType<typeof vi.fn>[] = [];
  const sizes: Array<(height: number) => void> = [];
  const widgets = { setActive: vi.fn(), mount: vi.fn((_root: unknown, _id: string, height: (value: number) => void) => {
    const dispose = vi.fn(); const setVisible = vi.fn();
    disposals.push(dispose); visibility.push(setVisible); sizes.push(height); return { dispose, setVisible };
  }) };
  const overlay = createSparkHomeWidgetOverlay({ host, widgets, documentRoot, windowRoot });
  const emit = (source: unknown, data: unknown) => windowRoot.dispatchEvent(Object.assign(new Event("message"), { source, data }));
  return { host, frame, widgets, overlay, disposals, visibility, sizes, emit };
}

test("layout parser rejects unknown identities, stale revisions, duplicates and out-of-bounds geometry", () => {
  expect(captureHomeWidgetLayout(layout(), 7)).toEqual(layout().slots);
  expect(captureHomeWidgetLayout(layout(), 8)).toBeNull();
  expect(captureHomeWidgetLayout(layout({ version: 2 }), 7)).toBeNull();
  for (const slot of [
    { instanceId: "outside", widgetId: "skills", rect },
    { instanceId: "home-widget-1", widgetId: "execute-tool", rect },
    { instanceId: "home-widget-1", widgetId: "skills", rect: { ...rect, width: Infinity } },
    { instanceId: "home-widget-1", widgetId: "skills", rect: { ...rect, height: 601 } },
  ]) expect(captureHomeWidgetLayout(layout({ slots: [slot] }), 7)).toBeNull();
  expect(captureHomeWidgetLayout(layout({ slots: [...layout().slots, ...layout().slots] }), 7)).toBeNull();
  expect(captureHomeWidgetLayout(layout({ slots: Array(5).fill(layout().slots[0]) }), 7)).toBeNull();
});

test("layout retains the ten-instance bound when the catalog grows", () => {
  const slots = SPARK_HOME_WIDGET_CATALOG.entries.slice(0, 10).map((widget, index) => ({
    instanceId: `home-widget-${index + 1}`, widgetId: widget.id, rect: { ...rect, height: widget.defaultHeight },
  }));
  expect(captureHomeWidgetLayout(layout({ slots }), 7)).toEqual(slots);
  for (const instanceId of ["home-widget-0", "home-widget-01", "home-widget-11", "home-widget-99999999999999999999"])
    expect(captureHomeWidgetLayout(layout({ slots: [{ ...slots[0], instanceId }] }), 7)).toBeNull();
  expect(captureHomeWidgetLayout(layout({ slots: [...slots, { ...slots[0], instanceId: "home-widget-11" }] }), 7)).toBeNull();
  expect(captureHomeWidgetLayout(layout({ slots: [{ ...slots[0], widgetId: "system-metrics" }] }), 7))
    .toMatchObject([{ widgetId: "system-metrics" }]);
});

test("only current outer-frame layout can mount native UI, and geometry is bounded by native widget height", () => {
  const f = fixture(); f.overlay.bind(f.frame, state);
  f.emit({}, layout()); f.emit(f.frame.contentWindow, layout({ revision: 6 }));
  f.emit(f.frame.contentWindow, { kind: "approve-candidate", id: "candidate", revision: 7 });
  expect(f.widgets.mount).not.toHaveBeenCalled();
  f.emit(f.frame.contentWindow, layout());
  expect(f.widgets.mount).toHaveBeenCalledOnce();
  const root = f.host.querySelector(".spark-home-native-widget")!;
  expect(root.style.getPropertyValue("left")).toBe("-8px");
  expect(root.style.getPropertyValue("top")).toBe("25px");
  expect(root.style.getPropertyValue("width")).toBe("320px");
  expect(root.style.getPropertyValue("height")).toBe("360px");
  expect(root.hidden).toBe(false);
  expect(f.visibility[0]).toHaveBeenLastCalledWith(true);
  f.sizes[0](220);
  expect(f.frame.contentWindow.postMessage).toHaveBeenLastCalledWith({ kind: "abot.spark-home-widget-sizing", version: 1, revision: 7,
    sizes: [{ instanceId: "home-widget-1", height: 220 }] }, "*");
  f.emit(f.frame.contentWindow, layout({ slots: [{ ...layout().slots[0], rect: null }] }));
  expect(root.hidden).toBe(true);
  expect(f.visibility[0]).toHaveBeenLastCalledWith(false);
  f.overlay.destroy();
});

test("new revision or environment disposes old native views and old frame messages cannot restore them", () => {
  const f = fixture(); f.overlay.bind(f.frame, state); f.emit(f.frame.contentWindow, layout());
  const nextFrame = { contentWindow: { postMessage: vi.fn() } };
  f.overlay.bind(nextFrame, { ...state, environmentId: "prod", screen: { revision: 8 } });
  expect(f.disposals[0]).toHaveBeenCalledOnce();
  expect(f.host.querySelector(".spark-home-native-widget")).toBeNull();
  f.emit(f.frame.contentWindow, layout({ revision: 8 }));
  expect(f.widgets.mount).toHaveBeenCalledOnce();
  f.emit(nextFrame.contentWindow, layout({ revision: 8 }));
  expect(f.widgets.mount).toHaveBeenCalledTimes(2);
  f.overlay.bind(nextFrame, { ...state, mode: "dashboard", environmentId: "prod", screen: { revision: 8 } });
  expect(f.host.querySelector(".spark-home-widget-overlay")!.hidden).toBe(true);
  expect(f.widgets.setActive).toHaveBeenLastCalledWith(false);
  f.overlay.destroy();
  expect(f.disposals[1]).toHaveBeenCalledOnce();
  f.emit(nextFrame.contentWindow, layout({ revision: 8 }));
  expect(f.widgets.mount).toHaveBeenCalledTimes(2);
});

test("removing or replacing a layout slot disposes its native view without accepting action data", () => {
  const f = fixture(); f.overlay.bind(f.frame, state); f.emit(f.frame.contentWindow, layout());
  f.emit(f.frame.contentWindow, layout({ slots: [{ instanceId: "home-widget-1", widgetId: "skills", rect, action: "delete-all" }] }));
  expect(f.disposals[0]).toHaveBeenCalledOnce();
  expect(f.widgets.mount).toHaveBeenLastCalledWith(expect.anything(), "skills", expect.any(Function));
  f.emit(f.frame.contentWindow, layout({ slots: [] }));
  expect(f.disposals[1]).toHaveBeenCalledOnce();
  expect(f.host.querySelector(".spark-home-native-widget")).toBeNull();
  f.overlay.destroy();
});

test.each(["failed", "cancelled"])("a %s generation restores the same widgets without another geometry message", outcome => {
  const f = fixture(); f.overlay.bind(f.frame, state); f.emit(f.frame.contentWindow, layout());
  const root = f.host.querySelector(".spark-home-native-widget")!;
  const layer = f.host.querySelector(".spark-home-widget-overlay")!;
  f.overlay.bind(f.frame, { ...state, generationPhase: "working" });
  f.emit(f.frame.contentWindow, layout());
  expect(layer.hidden).toBe(true);
  expect(f.widgets.setActive).toHaveBeenLastCalledWith(false);

  f.overlay.bind(f.frame, { ...state, generationPhase: "", generationNotice: `HOME ${outcome}.` });
  expect(layer.hidden).toBe(false);
  expect(root.hidden).toBe(false);
  expect(f.widgets.setActive).toHaveBeenLastCalledWith(true);
  expect(f.host.querySelector(".spark-home-native-widget")).toBe(root);
  expect(f.widgets.mount).toHaveBeenCalledOnce();
  expect(f.disposals[0]).not.toHaveBeenCalled();
  f.overlay.destroy();
});

test.each([null, { ...rect, width: 0 }, { ...rect, height: 0 }])("reenabling HOME keeps absent or zero-sized geometry hidden: %j", geometry => {
  const f = fixture(); f.overlay.bind(f.frame, { ...state, generationPhase: "working" });
  f.emit(f.frame.contentWindow, layout({ slots: [{ ...layout().slots[0], rect: geometry }] }));
  const root = f.host.querySelector(".spark-home-native-widget")!;
  f.overlay.bind(f.frame, state);
  expect(f.host.querySelector(".spark-home-widget-overlay")!.hidden).toBe(false);
  expect(root.hidden).toBe(true);
  expect(f.widgets.mount).toHaveBeenCalledOnce();
  f.overlay.destroy();
});

test("reenabling HOME does not reveal a native component whose current height is zero", () => {
  const f = fixture(); f.overlay.bind(f.frame, { ...state, generationPhase: "working" });
  f.emit(f.frame.contentWindow, layout());
  f.sizes[0](0);
  f.emit(f.frame.contentWindow, layout());
  f.overlay.bind(f.frame, state);
  expect(f.host.querySelector(".spark-home-native-widget")!.hidden).toBe(true);
  expect(f.widgets.setActive).toHaveBeenLastCalledWith(true);
  f.overlay.destroy();
});
