import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser placement module.
import { createSparkChatPlacement } from "../../web-ui/app/components/spark-chat/placement.js";

class ElementStub extends EventTarget {
  style: Record<string, string> = {};
  classes = new Set<string>();
  classList = { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name) };
  parentNode: ElementStub | null = null;
  ownerDocument: { body: ElementStub; activeElement: ElementStub | null } | undefined;
  capture: number | null = null;
  closest() { return this.parentNode; }
  constructor(readonly box = { left: 12, top: 650, width: 146, height: 52 }) { super(); }
  append(node: ElementStub) {
    if (node.parentNode !== this && node.ownerDocument?.activeElement === node) node.ownerDocument.activeElement = null;
    node.parentNode = this;
  }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  setPointerCapture(id: number) { this.capture = id; }
  hasPointerCapture(id: number) { return this.capture === id; }
  releasePointerCapture() { this.capture = null; }
  getBoundingClientRect() {
    const floating = this.classes.has("spark-launcher-floating");
    const left = this.style.left ? parseFloat(this.style.left) : this.box.left;
    const top = this.style.top ? parseFloat(this.style.top) : this.box.top;
    const width = floating ? 60 : this.box.width;
    const height = this.style.height ? parseFloat(this.style.height) : floating ? 60 : this.box.height;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
}

function fire(target: EventTarget, name: string, values = {}) {
  const event = Object.assign(new Event(name, { cancelable: true }), values);
  target.dispatchEvent(event);
  return event;
}

function fixture(saved: unknown = null, storageUnavailable = false) {
  const body = new ElementStub();
  const documentRoot = { body, activeElement: null as ElementStub | null };
  const root = new ElementStub(); root.ownerDocument = documentRoot;
  const navigation = new ElementStub({ left: 0, top: 0, width: 166, height: 800 });
  const dockAnchor = new ElementStub(); navigation.append(dockAnchor);
  const launcher = new ElementStub(); launcher.ownerDocument = documentRoot; dockAnchor.append(launcher);
  const panel = new ElementStub({ left: 0, top: 0, width: 390, height: 560 });
  const notice = new ElementStub({ left: 0, top: 0, width: 260, height: 90 });
  const windowRoot = Object.assign(new EventTarget(), {
    innerWidth: 1000, innerHeight: 800,
    setTimeout: vi.fn((_callback: () => void, _delay: number) => 1), clearTimeout: vi.fn(),
  });
  const storage = { getItem: vi.fn(() => saved === null ? null : JSON.stringify(saved)), setItem: vi.fn(), removeItem: vi.fn() };
  Object.defineProperty(windowRoot, "localStorage", { get() { throw Error("storage disabled"); } });
  const placement = createSparkChatPlacement({ root, launcher, panel, notice, dockAnchor, storage: storageUnavailable ? undefined : storage, windowRoot });
  const move = (x: number, y: number) => {
    const rect = launcher.getBoundingClientRect();
    fire(launcher, "pointerdown", { button: 0, pointerId: 1, clientX: rect.left + 5, clientY: rect.top + 5 });
    fire(windowRoot, "pointermove", { pointerId: 1, clientX: x, clientY: y });
    fire(windowRoot, "pointerup", { pointerId: 1, clientX: x, clientY: y });
  };
  return { body, documentRoot, root, navigation, dockAnchor, launcher, panel, notice, windowRoot, storage, placement, move };
}

describe("SPARK browser placement", () => {
  test("defaults to the sidebar and opens above its icon with a clear gap", () => {
    const f = fixture();
    expect(f.placement.isDocked()).toBe(true);
    expect(f.launcher.parentNode).toBe(f.dockAnchor);
    expect(f.panel.getBoundingClientRect().bottom).toBe(f.launcher.getBoundingClientRect().top - 12);
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });

  test("a click or small movement stays docked and remains an ordinary click", () => {
    const f = fixture(); const open = vi.fn(); f.launcher.addEventListener("click", open);
    fire(f.launcher, "pointerdown", { button: 0, pointerId: 1, clientX: 30, clientY: 670 });
    fire(f.windowRoot, "pointermove", { pointerId: 1, clientX: 32, clientY: 672 });
    fire(f.windowRoot, "pointerup", { pointerId: 1 }); fire(f.launcher, "click");
    expect(f.placement.isDocked()).toBe(true);
    expect(open).toHaveBeenCalledOnce(); expect(f.storage.setItem).not.toHaveBeenCalled();
  });

  test("drag persists browser coordinates and consumes only its completion click", () => {
    const f = fixture(); const open = vi.fn(); f.launcher.addEventListener("click", open);
    f.move(600, 400);
    expect(f.placement.isDocked()).toBe(false); expect(f.launcher.parentNode).toBe(f.body);
    expect(f.launcher.classList).toBeDefined(); expect(f.storage.setItem).toHaveBeenCalledOnce();
    expect(fire(f.launcher, "click").defaultPrevented).toBe(true); expect(open).not.toHaveBeenCalled();
    fire(f.launcher, "click"); expect(open).toHaveBeenCalledOnce();
    expect(f.launcher.capture).toBeNull();
  });

  test("dropping anywhere in the navigation restores the original dock and clears saved coordinates", () => {
    const f = fixture({ x: 500, y: 400 });
    f.dockAnchor.box.width = 0; f.dockAnchor.box.height = 0;
    f.launcher.focus();
    const open = vi.fn(); f.launcher.addEventListener("click", open);
    f.move(80, 120);
    expect(f.placement.isDocked()).toBe(true);
    expect(f.launcher.parentNode).toBe(f.dockAnchor);
    expect(f.launcher.classes.has("spark-launcher-floating")).toBe(false);
    expect(f.launcher.style).toMatchObject({ position: "", left: "", top: "" });
    expect(f.storage.removeItem).toHaveBeenCalledWith("abot.spark.launcher.position.v1");
    expect(f.storage.setItem).not.toHaveBeenCalled();
    expect(f.documentRoot.activeElement).toBe(f.launcher);
    expect(fire(f.launcher, "click").defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
    fire(f.launcher, "click"); expect(open).toHaveBeenCalledOnce();
  });

  test("the release position decides docking, including a horizontal navigation bar", () => {
    const f = fixture({ x: 500, y: 400 });
    Object.assign(f.navigation.box, { left: 0, top: 0, width: 1000, height: 60 });
    fire(f.launcher, "pointerdown", { button: 0, pointerId: 1, clientX: 505, clientY: 405 });
    fire(f.windowRoot, "pointermove", { pointerId: 1, clientX: 600, clientY: 300 });
    fire(f.windowRoot, "pointerup", { pointerId: 1, clientX: 600, clientY: 30 });
    expect(f.placement.isDocked()).toBe(true);
    expect(f.launcher.parentNode).toBe(f.dockAnchor);
  });

  test("cancelled drags over the navigation stay floating", () => {
    const f = fixture({ x: 500, y: 400 });
    fire(f.launcher, "pointerdown", { button: 0, pointerId: 1, clientX: 505, clientY: 405 });
    fire(f.windowRoot, "pointermove", { pointerId: 1, clientX: 80, clientY: 120 });
    fire(f.windowRoot, "pointercancel", { pointerId: 1, clientX: 80, clientY: 120 });
    expect(f.placement.isDocked()).toBe(false);
    expect(f.launcher.parentNode).toBe(f.body);
    expect(f.storage.removeItem).not.toHaveBeenCalled();
    expect(f.launcher.capture).toBeNull();
  });

  test("hidden navigation and drops just outside its bounds stay floating", () => {
    const f = fixture({ x: 500, y: 400 });
    f.move(167, 120);
    expect(f.placement.isDocked()).toBe(false);
    f.navigation.box.height = 0;
    f.move(80, 0);
    expect(f.placement.isDocked()).toBe(false);
    expect(f.storage.removeItem).not.toHaveBeenCalled();
  });

  test("stored top, bottom and middle positions keep the popup above or below the icon", () => {
    for (const y of [12, 350, 728]) {
      const f = fixture({ x: 930, y });
      const icon = f.launcher.getBoundingClientRect(); const popup = f.panel.getBoundingClientRect();
      expect(popup.bottom <= icon.top - 12 || popup.top >= icon.bottom + 12).toBe(true);
      expect(popup.top).toBeGreaterThanOrEqual(12); expect(popup.bottom).toBeLessThanOrEqual(788);
      expect(popup.left).toBeGreaterThanOrEqual(12); expect(popup.right).toBeLessThanOrEqual(988);
      if (y === 350) expect(popup.height).toBe(366);
    }
  });

  test("a new deliberate click works when drag reparenting emits no completion click", () => {
    const f = fixture(); const open = vi.fn(); f.launcher.addEventListener("click", open);
    f.move(500, 500);
    const [clearSuppression, delay] = f.windowRoot.setTimeout.mock.calls[0]!;
    expect(delay).toBe(0); clearSuppression();
    fire(f.launcher, "click"); expect(open).toHaveBeenCalledOnce();
    f.move(300, 300);
    fire(f.launcher, "pointerdown", { button: 0, pointerId: 1, clientX: 300, clientY: 300 });
    fire(f.windowRoot, "pointerup", { pointerId: 1 });
    fire(f.launcher, "click"); expect(open).toHaveBeenCalledTimes(2);
  });

  test("viewport resize clamps saved positions and the popup regrows after moving away from the middle", () => {
    const f = fixture({ x: 930, y: 350 });
    expect(f.panel.getBoundingClientRect().height).toBe(366);
    f.move(200, 780);
    expect(f.panel.getBoundingClientRect().height).toBe(560);
    f.windowRoot.innerWidth = 640; f.windowRoot.innerHeight = 500; fire(f.windowRoot, "resize");
    const icon = f.launcher.getBoundingClientRect(); const popup = f.panel.getBoundingClientRect();
    expect(icon.right).toBeLessThanOrEqual(628); expect(icon.bottom).toBeLessThanOrEqual(488);
    expect(popup.bottom).toBe(icon.top - 12); expect(popup.height).toBeLessThan(560);
  });

  test("invalid storage values safely default to the dock and reset clears only the position", () => {
    for (const invalid of [{ x: "20", y: 20 }, { x: null, y: 20 }, { y: 20 }, []]) expect(fixture(invalid).placement.isDocked()).toBe(true);
    const f = fixture({ x: 99999, y: -99999 });
    expect(f.launcher.getBoundingClientRect()).toMatchObject({ left: 928, top: 12 });
    f.placement.reset(); expect(f.launcher.parentNode).toBe(f.dockAnchor); expect(f.placement.isDocked()).toBe(true);
    expect(f.storage.removeItem).toHaveBeenCalledWith("abot.spark.launcher.position.v1");
  });

  test("keyboard movement and reset are available without dragging and storage failure does not block placement", () => {
    const f = fixture(); f.storage.setItem.mockImplementation(() => { throw Error("blocked"); });
    expect(fire(f.launcher, "keydown", { altKey: true, key: "ArrowRight" }).defaultPrevented).toBe(true);
    expect(f.placement.isDocked()).toBe(false);
    fire(f.launcher, "keydown", { altKey: true, key: "Home" }); expect(f.placement.isDocked()).toBe(true);
    f.placement.destroy(); fire(f.launcher, "keydown", { altKey: true, key: "ArrowRight" }); expect(f.placement.isDocked()).toBe(true);
  });

  test("a blocked browser localStorage getter still permits dragging and reset", () => {
    const f = fixture(null, true);
    expect(f.placement.isDocked()).toBe(true);
    expect(() => f.move(500, 500)).not.toThrow(); expect(f.placement.isDocked()).toBe(false);
    expect(() => f.placement.reset()).not.toThrow(); expect(f.placement.isDocked()).toBe(true);
  });

  test("keyboard focus follows reparenting so users can continue moving and reset without focus theft", () => {
    const f = fixture(); f.launcher.focus();
    fire(f.launcher, "keydown", { altKey: true, key: "ArrowRight" });
    expect(f.documentRoot.activeElement).toBe(f.launcher);
    fire(f.launcher, "keydown", { altKey: true, key: "Home" });
    expect(f.placement.isDocked()).toBe(true); expect(f.documentRoot.activeElement).toBe(f.launcher);
    const other = new ElementStub(); f.documentRoot.activeElement = other;
    f.move(400, 400); expect(f.documentRoot.activeElement).toBe(other);
    f.placement.reset(); expect(f.documentRoot.activeElement).toBe(other);
  });
});
