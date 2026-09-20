import { ContextElement } from "./composer-context-window-dom.js";

type PreviewEvent = {
  key?: string;
  shiftKey?: boolean;
  preventDefault?: () => void;
};

export function createFilePreviewDom(narrow = false) {
  let activeElement: PreviewElement | null = null;
  class PreviewElement extends ContextElement {
    override tabIndex = -1;
    inert = false;
    open = false;
    scrollTop = 0;
    scrollLeft = 0;
    innerHTML = "";
    href = "";
    download = "";
    src = "";
    alt = "";
    dir = "";
    get isConnected(): boolean {
      return body.contains(this);
    }
    focus() {
      activeElement = this;
    }
    getBoundingClientRect() {
      return { top: 0, bottom: 100, height: 100, width: 600 };
    }
    matches(selector: string): boolean {
      if (selector === "[hidden]") return this.hidden;
      if (selector === "a[href]")
        return this.tagName === "a" && Boolean(this.href);
      if (selector === "[tabindex='0']")
        return this.tabIndex === 0 && this.tagName === "div";
      return super.matches(selector);
    }
    closest(selector: string): PreviewElement | null {
      for (
        let current: PreviewElement | null = this;
        current;
        current = current.parentElement as PreviewElement | null
      ) {
        if (current.matches(selector)) return current;
      }
      return null;
    }
    querySelectorAll(selector: string): PreviewElement[] {
      const result: PreviewElement[] = [];
      const selectors = selector.split(",").map((part) => part.trim());
      for (const child of this.children as PreviewElement[]) {
        if (selectors.some((part) => child.matches(part))) result.push(child);
        result.push(...child.querySelectorAll(selector));
      }
      return result;
    }
  }
  const body = new PreviewElement("body");
  const navigation = new PreviewElement("nav");
  const host = new PreviewElement("main");
  const chat = new PreviewElement("section");
  const opener = new PreviewElement("button");
  opener.className = "conversation-tool-file-action";
  opener.dataset.requestId = "r1";
  opener.dataset.executionId = "e1";
  chat.appendChild(opener);
  host.appendChild(chat);
  body.append(navigation, host);
  const events = new ContextElement("document");
  const changes: Array<() => void> = [];
  const query = {
    matches: narrow,
    addEventListener: (_name: string, fn: () => void) => changes.push(fn),
  };
  const documentRoot = {
    body,
    get activeElement() {
      return activeElement;
    },
    createElement: (tag: string) => new PreviewElement(tag),
    addEventListener: events.addEventListener.bind(events),
  };
  const viewport = {
    location: { href: "http://localhost:5177/" },
    matchMedia: () => query,
  };
  return {
    body,
    navigation,
    host,
    chat,
    opener,
    element: (tag: string) => new PreviewElement(tag),
    get activeElement() {
      return activeElement;
    },
    documentRoot: documentRoot as unknown as Document,
    viewport: viewport as unknown as Window,
    key(event: PreviewEvent) {
      events.dispatch("keydown", event);
    },
    resize(nextNarrow: boolean) {
      query.matches = nextNarrow;
      changes.forEach((fn) => fn());
    },
  };
}
