import { describe, expect, test } from "vitest";
// @ts-expect-error Browser-only controller has no declaration surface.
import { createPanelWidthResizer } from "../../web-ui/app/components/panel-width-resizer.js";

type Input = { pointerId?: number; button?: number; isPrimary?: boolean; clientX?: number; key?: string; preventDefault(): void; stopPropagation(): void };
function fixture(edge = "right") {
  const listeners = new Map<string, (event: Input) => void>();
  const viewportListeners = new Map<string, () => void>();
  const attributes = new Map<string, string>();
  const captures = new Set<number>();
  const classes = new Set<string>();
  let width = 288;
  let saved = "";
  let enabled = true;
  let max = 480;
  let observeSize: (() => void) | undefined;
  class PanelResizeObserver {
    constructor(listener: () => void) { observeSize = listener; }
    observe() {}
  }
  const handle = {
    hidden: false,
    classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    addEventListener: (name: string, listener: (event: Input) => void) => listeners.set(name, listener),
    setPointerCapture: (id: number) => captures.add(id),
    hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture(id: number) {
      captures.delete(id);
      dispatch("lostpointercapture", { pointerId: id });
    },
    focus() {},
  };
  function dispatch(name: string, values: Partial<Input> = {}) {
    const event = { pointerId: 7, button: 0, isPrimary: true, clientX: 288, ...values,
      defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
    listeners.get(name)?.(event);
    return event;
  }
  const controller = createPanelWidthResizer({
    handle, edge,
    panel: { getBoundingClientRect: () => ({ width }) },
    viewport: { ResizeObserver: PanelResizeObserver, addEventListener: (name: string, listener: () => void) => viewportListeners.set(name, listener) },
    isEnabled: () => enabled,
    getBounds: () => ({ min: 220, max }),
    captureWidth: () => saved,
    applyWidth: (value: number) => { width = value; saved = `${value}px`; },
    restoreWidth: (value: string) => { saved = value; width = value ? parseFloat(value) : 288; },
  });
  controller.sync();
  return { handle, controller, dispatch, attributes, captures, classes,
    width: () => width, saved: () => saved,
    enable(value: boolean) { enabled = value; controller.sync(); },
    resizeViewport(nextMax: number) { max = nextMax; viewportListeners.get("resize")?.(); },
    blur() { viewportListeners.get("blur")?.(); },
    layoutWidth(value: number) { width = value; observeSize?.(); },
  };
}

describe("conversation panel width gestures", () => {
  test("captures a primary drag, adjusts the sidebar and retains its width after release", () => {
    const f = fixture();
    f.dispatch("pointerdown");
    expect(f.captures.has(7)).toBe(true);
    f.dispatch("pointermove", { clientX: 360 });
    expect(f.width()).toBe(360);
    expect(f.attributes.get("aria-valuenow")).toBe("360");
    f.dispatch("pointerup", { clientX: 376 });
    expect(f.width()).toBe(376);
    expect(f.saved()).toBe("376px");
    expect(f.captures.size).toBe(0);
    expect(f.classes.has("is-resizing")).toBe(false);
    f.dispatch("pointermove", { clientX: 400 });
    expect(f.width()).toBe(376);
  });

  test("the Git panel grows leftward, clamps both extremes, and does not resize another panel", () => {
    const git = fixture("left");
    const conversations = fixture();
    git.dispatch("pointerdown", { clientX: 900 });
    git.dispatch("pointermove", { clientX: 700 });
    expect(git.width()).toBe(480);
    git.dispatch("pointerup", { clientX: 1200 });
    expect(git.width()).toBe(220);
    expect(conversations.width()).toBe(288);
  });

  test("ignores right-click, secondary pointers and events from another active pointer", () => {
    const f = fixture();
    f.dispatch("pointerdown", { button: 2 });
    f.dispatch("pointermove", { clientX: 410 });
    expect(f.width()).toBe(288);
    f.dispatch("pointerdown", { isPrimary: false });
    expect(f.captures.size).toBe(0);
    f.dispatch("pointerdown");
    f.dispatch("pointermove", { pointerId: 8, clientX: 400 });
    f.dispatch("pointerup", { pointerId: 8, clientX: 400 });
    expect(f.width()).toBe(288);
    expect(f.captures.has(7)).toBe(true);
  });

  test.each(["pointercancel", "lostpointercapture", "Escape", "blur"])("%s cancels the drag and restores the previous width", (event) => {
    const f = fixture();
    f.dispatch("keydown", { key: "ArrowRight" });
    expect(f.saved()).toBe("304px");
    f.dispatch("pointerdown");
    f.dispatch("pointermove", { clientX: 400 });
    if (event === "Escape") f.dispatch("keydown", { key: "Escape" });
    else if (event === "blur") f.blur();
    else f.dispatch(event);
    expect(f.width()).toBe(304);
    expect(f.saved()).toBe("304px");
    expect(f.attributes.get("aria-valuenow")).toBe("304");
    expect(f.captures.size).toBe(0);
    expect(f.classes.has("is-resizing")).toBe(false);
  });

  test("keyboard resizing follows the physical separator edge and exposes current limits", () => {
    const f = fixture("left");
    const event = f.dispatch("keydown", { key: "ArrowLeft" });
    expect(f.width()).toBe(304);
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
    f.dispatch("keydown", { key: "Home" });
    expect(f.width()).toBe(220);
    f.resizeViewport(360);
    f.dispatch("keydown", { key: "End" });
    expect(f.width()).toBe(360);
    expect(f.attributes.get("aria-valuemin")).toBe("220");
    expect(f.attributes.get("aria-valuemax")).toBe("360");
    expect(f.attributes.get("aria-valuenow")).toBe("360");
  });

  test("peer layout changes refresh accessible width without overwriting the preferred size", () => {
    const f = fixture();
    f.layoutWidth(350);
    expect(f.attributes.get("aria-valuenow")).toBe("350");
    expect(f.saved()).toBe("");
  });

  test("leaving the docked layout cancels capture and blocks hidden-handle interactions", () => {
    const f = fixture();
    f.dispatch("pointerdown");
    f.dispatch("pointermove", { clientX: 400 });
    f.enable(false);
    expect(f.width()).toBe(288);
    expect(f.saved()).toBe("");
    expect(f.handle.hidden).toBe(true);
    f.dispatch("pointerdown");
    f.dispatch("keydown", { key: "End" });
    expect(f.captures.size).toBe(0);
    expect(f.width()).toBe(288);
    f.enable(true);
    expect(f.handle.hidden).toBe(false);
  });
});
