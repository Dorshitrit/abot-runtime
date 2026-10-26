import { vi } from "vitest";
import { FakeElement } from "./model-setup-wizard-harness.js";

type Observer = { callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };

export function createRailScrollHarness({ count = 10, height = 240, desktop = true, navigation = "icons", reducedMotion = false } = {}) {
  const frames = new Map<number, () => void>();
  let frameId = 0;
  const resizeObservers: Observer[] = [];
  const mutationObservers: Observer[] = [];
  const mediaListeners = new Set<() => void>();
  const viewportListeners = new Map<string, Set<() => void>>();
  const documentRoot = {} as FakeElement["ownerDocument"] & { defaultView: typeof viewport };

  class RailElement extends FakeElement {
    offset = 0;
    constructor(tag: string) {
      super(tag, documentRoot);
      Object.defineProperty(this, "scrollTop", {
        get: () => this.offset,
        set: (value: number) => {
          const next = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
          if (next === this.offset) return;
          this.offset = next;
          this.dispatch("scroll");
        },
      });
    }
    override get type() { return super.type; }
    set type(value: string) { this.setAttribute("type", value); }
    override append(...nodes: FakeElement[]) { nodes.forEach((node) => super.append(node)); }
    insertBefore(node: FakeElement, reference: FakeElement | null) {
      node.remove();
      const index = reference ? this.children.indexOf(reference) : -1;
      this.children.splice(index < 0 ? this.children.length : index, 0, node);
      node.parentElement = this;
      return node;
    }
    removeEventListener(name: string, listener: (event: any) => void) {
      this.listeners.set(name, (this.listeners.get(name) || []).filter((entry) => entry !== listener));
    }
    get clientHeight(): number {
      if (this.className === "rail-scroll-frame") return height;
      if (this.className === "rail-actions") return height - (this.parentElement?.dataset.railOverflow === "true" ? 44 : 0);
      return this.className.includes("rail-scroll-button") ? 22 : 44;
    }
    get scrollHeight(): number {
      if (this.className !== "rail-actions") return this.clientHeight;
      return this.visibleButtons().length * 46;
    }
    visibleButtons() { return this.children.filter((item): item is RailElement => item instanceof RailElement && !item.hidden); }
    getClientRects() {
      for (let ancestor: FakeElement | null = this; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.hidden) return [];
      }
      return [this.getBoundingClientRect()];
    }
    getBoundingClientRect(): { top: number; bottom: number; height: number } {
      const parent = this.parentElement as RailElement | null;
      const top = parent?.className === "rail-actions"
        ? parent.getBoundingClientRect().top + parent.visibleButtons().indexOf(this) * 46 - parent.scrollTop
        : 100 + (this.className === "rail-actions" && parent?.dataset.railOverflow === "true" ? 22 : 0);
      return { top, bottom: top + this.clientHeight, height: this.clientHeight };
    }
    scrollBy = vi.fn((options: { top: number; behavior: string }) => { this.scrollTop += options.top; });
    scrollIntoView = vi.fn();
  }
  const media = {
    get matches() { return desktop; },
    addEventListener: (_name: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_name: string, listener: () => void) => mediaListeners.delete(listener),
  };
  const viewport = {
    matchMedia: (query: string) => query === "(prefers-reduced-motion: reduce)" ? { get matches() { return reducedMotion; } } : media,
    requestAnimationFrame(callback: () => void) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    addEventListener(name: string, callback: () => void) {
      if (!viewportListeners.has(name)) viewportListeners.set(name, new Set());
      viewportListeners.get(name)!.add(callback);
    },
    removeEventListener(name: string, callback: () => void) { viewportListeners.get(name)?.delete(callback); },
    ResizeObserver: class {
      observe = vi.fn(); disconnect = vi.fn();
      constructor(readonly callback: () => void) { resizeObservers.push(this); }
    },
    MutationObserver: class {
      observe = vi.fn(); disconnect = vi.fn();
      constructor(readonly callback: () => void) { mutationObservers.push(this); }
    },
  };
  documentRoot.createElement = (tag) => new RailElement(tag);
  documentRoot.documentElement = new RailElement("html");
  documentRoot.documentElement.dataset.navigation = navigation;
  documentRoot.body = new RailElement("body");
  documentRoot.activeElement = documentRoot.body;
  documentRoot.defaultView = viewport;
  const rail = new RailElement("nav"); rail.className = "workspace-rail";
  const actions = new RailElement("div"); actions.className = "rail-actions";
  const footer = new RailElement("div"); footer.className = "rail-footer";
  documentRoot.body.append(rail); rail.append(actions, footer);
  const addButton = () => {
    const button = new RailElement("button"); button.className = "rail-button";
    actions.append(button); return button;
  };
  const buttons = Array.from({ length: count }, addButton);
  buttons[0]?.setAttribute("aria-current", "page");
  function notifyMutations(target: FakeElement) {
    mutationObservers.filter((observer) => observer.observe.mock.calls.some(([observed]) => observed === target))
      .forEach((observer) => observer.callback());
  }
  function flushFrames() {
    for (let attempt = 0; frames.size && attempt < 20; attempt++) {
      const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback());
    }
    if (frames.size) throw new Error("rail animation frame loop");
  }
  return {
    rail, actions, footer, buttons, documentRoot, viewport, addButton, flushFrames, frames, resizeObservers, mutationObservers,
    up: () => rail.querySelector(".rail-scroll-up") as RailElement,
    down: () => rail.querySelector(".rail-scroll-down") as RailElement,
    frame: () => rail.querySelector(".rail-scroll-frame") as RailElement,
    mutate: () => { notifyMutations(actions); flushFrames(); },
    resize(value: number) { height = value; resizeObservers.forEach((observer) => observer.callback()); flushFrames(); },
    navigation(value: string) { documentRoot.documentElement.dataset.navigation = value; notifyMutations(documentRoot.documentElement); flushFrames(); },
    desktop(value: boolean) { desktop = value; mediaListeners.forEach((listener) => listener()); flushFrames(); },
    reducedMotion(value: boolean) { reducedMotion = value; },
  };
}
