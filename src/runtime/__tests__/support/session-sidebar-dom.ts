import { vi } from "vitest";
import { ContextElement } from "./composer-context-window-dom.js";

export class SidebarElement extends ContextElement {
  title = "";
  draggable = false;
  focus = vi.fn();
  private markup = "";
  get innerHTML() { return this.markup; }
  set innerHTML(value: string) {
    this.markup = value;
    this.replaceChildren();
    for (const match of value.matchAll(/<button\b([^>]*)>/g)) {
      const button = new SidebarElement("button");
      button.className = match[1]?.match(/class="([^"]*)"/)?.[1] ?? "";
      button.id = match[1]?.match(/id="([^"]*)"/)?.[1] ?? "";
      this.appendChild(button);
    }
  }
  getBoundingClientRect() { return { top: 0, height: 20 }; }
}

export function allSidebarElements(root: ContextElement): ContextElement[] {
  return [root, ...root.children.flatMap(allSidebarElements)];
}

export function sidebarStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: (key: string) => { values.delete(key); },
  };
}

export function dragEvent(clientY = 0) {
  return {
    clientY, relatedTarget: null, preventDefault: vi.fn(),
    dataTransfer: { effectAllowed: "", dropEffect: "", setData: vi.fn() },
  };
}
