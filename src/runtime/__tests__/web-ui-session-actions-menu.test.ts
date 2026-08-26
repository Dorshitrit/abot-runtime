import { describe, expect, test } from "vitest";

import {
  createSessionActionsMenu,
  nextSessionActionIndex,
} from "../../web-ui/app/components/session-actions-menu.js";

class FakeClassList {
  constructor(private readonly owner: FakeElement) {}

  add(token: string): void {
    const classes = new Set(this.owner.className.split(/\s+/u).filter(Boolean));
    classes.add(token);
    this.owner.className = [...classes].join(" ");
  }

  remove(token: string): void {
    this.owner.className = this.owner.className
      .split(/\s+/u)
      .filter((value) => value && value !== token)
      .join(" ");
  }

  contains(token: string): boolean {
    return this.owner.className.split(/\s+/u).includes(token);
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(event: any) => void>>();
  readonly classList = new FakeClassList(this);
  parent: FakeElement | null = null;
  className = "";
  hidden = false;
  disabled = false;

  constructor(
    className = "",
    private readonly documentRoot?: FakeDocument,
  ) {
    this.className = className;
  }

  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  addEventListener(name: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  emit(name: string, event: any): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  focus(): void {
    if (this.documentRoot) this.documentRoot.activeElement = this;
  }

  contains(candidate: unknown): boolean {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  closest(selector: string): FakeElement | null {
    const className = selector.startsWith(".") ? selector.slice(1) : "";
    if (className && this.classList.contains(className)) return this;
    return this.parent?.closest(selector) ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const classMatch = selector.includes(" ")
      ? undefined
      : selector.match(/^\.([\w-]+)/u)?.[1];
    const roleMatch = selector.includes('role="menuitem"');
    const matches = (element: FakeElement) =>
      (classMatch ? element.classList.contains(classMatch) : true) &&
      (roleMatch ? element.attributes.get("role") === "menuitem" : true) &&
      (!selector.includes(":not(:disabled)") || !element.disabled);
    return this.children.flatMap((child) => [
      ...(matches(child) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

class FakeDocument extends FakeElement {
  activeElement: FakeElement | null = null;
}

function eventFor(target: FakeElement, key = "") {
  return {
    target,
    key,
    relatedTarget: null,
    preventDefault: () => {},
    stopPropagation: () => {},
  };
}

describe("web ui session actions menu", () => {
  test("wraps arrow navigation and honors menu boundaries", () => {
    expect(nextSessionActionIndex(0, "ArrowDown", 3)).toBe(1);
    expect(nextSessionActionIndex(2, "ArrowDown", 3)).toBe(0);
    expect(nextSessionActionIndex(0, "ArrowUp", 3)).toBe(2);
    expect(nextSessionActionIndex(1, "Home", 3)).toBe(0);
    expect(nextSessionActionIndex(1, "End", 3)).toBe(2);
    expect(nextSessionActionIndex(0, "ArrowDown", 0)).toBe(-1);
  });

  test("opens the action menu from its button and closes it accessibly", () => {
    const documentRoot = new FakeDocument();
    const container = new FakeElement("sessions-list", documentRoot);
    const actions = new FakeElement("session-actions", documentRoot);
    const button = new FakeElement("session-menu-button", documentRoot);
    const menu = new FakeElement("session-menu", documentRoot);
    const pin = new FakeElement("session-action pin-action", documentRoot);
    const reset = new FakeElement("session-action clear-action", documentRoot);
    const remove = new FakeElement(
      "session-action delete-action",
      documentRoot,
    );
    for (const item of [pin, reset, remove]) {
      item.setAttribute("role", "menuitem");
    }
    menu.hidden = true;
    menu.append(pin, reset, remove);
    actions.append(button, menu);
    container.append(actions);

    const controller = createSessionActionsMenu({
      container: container as unknown as HTMLElement,
      documentRoot: documentRoot as unknown as Document,
      viewport: {
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          callback(0);
          return 1;
        },
      } as unknown as Window,
    });
    controller.bind();

    container.emit("click", eventFor(button));
    expect(actions.classList.contains("open")).toBe(true);
    expect(button.attributes.get("aria-expanded")).toBe("true");
    expect(menu.hidden).toBe(false);
    expect(documentRoot.activeElement).toBe(pin);

    container.emit("keydown", eventFor(pin, "ArrowDown"));
    expect(documentRoot.activeElement).toBe(reset);
    container.emit("keydown", eventFor(reset, "Escape"));
    expect(actions.classList.contains("open")).toBe(false);
    expect(button.attributes.get("aria-expanded")).toBe("false");
    expect(menu.hidden).toBe(true);
    expect(documentRoot.activeElement).toBe(button);

    container.emit("click", eventFor(button));
    const outside = new FakeElement("outside", documentRoot);
    documentRoot.emit("click", eventFor(outside));
    expect(actions.classList.contains("open")).toBe(false);
  });
});
