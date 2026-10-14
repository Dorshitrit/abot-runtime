import { vi } from "vitest";
import { FakeElement } from "./model-setup-wizard-harness.js";

export class HomeWidgetElement extends FakeElement {
  get type() { return super.type; }
  set type(value: string) { this.setAttribute("type", value); }
  get parentNode() { return this.parentElement; }

  get classList() {
    return {
      contains: (name: string) => this.className.split(/\s+/).includes(name),
      add: (...names: string[]) => {
        this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" ");
      },
      remove: (...names: string[]) => {
        this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" ");
      },
      toggle: (name: string, force?: boolean) => {
        const enabled = force ?? !this.classList.contains(name);
        if (enabled) this.classList.add(name);
        else this.classList.remove(name);
        return enabled;
      },
    };
  }

  get innerHTML() { return super.innerHTML; }
  set innerHTML(value: string) {
    super.innerHTML = value;
    upgradeWidgetDescendants(this);
  }

  get firstChild() { return this.children[0] ?? null; }
  get nextSibling() {
    if (!this.parentElement) return null;
    const position = this.parentElement.children.indexOf(this);
    return this.parentElement.children[position + 1] ?? null;
  }

  get isConnected(): boolean {
    return this.ownerDocument.documentElement.contains(this);
  }

  append(...nodes: FakeElement[]) {
    for (const node of nodes) super.append(node);
  }

  appendChild(node: FakeElement) {
    this.append(node);
    return node;
  }

  insertBefore(node: FakeElement, reference: FakeElement | string | null) {
    if (node === reference) return node;
    node.remove();
    const position = reference ? this.children.indexOf(reference) : -1;
    this.children.splice(position < 0 ? this.children.length : position, 0, node);
    node.parentElement = this;
    return node;
  }

  removeChild(node: FakeElement) {
    node.remove();
    return node;
  }

  replaceChildren(...nodes: FakeElement[]) {
    this.innerHTML = "";
    this.append(...nodes);
  }

  before(node: FakeElement) {
    (this.parentElement as HomeWidgetElement | null)?.insertBefore(node, this);
  }

  removeEventListener(name: string, listener: (event: any) => void) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((entry) => entry !== listener));
  }

  matches(selector: string) {
    for (const [name, value] of Object.entries(this.dataset))
      this.attributes.set(`data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value);
    return selector.split(",").some((entry) => super.matches(entry.trim()));
  }

  removeAttribute(name: string) {
    super.removeAttribute(name);
    if (name === "hidden") this.hidden = false;
    if (name === "inert") this.inert = false;
    if (name === "disabled") this.disabled = false;
  }
}

function upgradeWidgetDescendants(root: FakeElement) {
  for (const child of root.children) {
    if (typeof child === "string") continue;
    Object.setPrototypeOf(child, HomeWidgetElement.prototype);
    upgradeWidgetDescendants(child);
  }
}

export function createHomeWidgetsHarness(width = 1280, hasMatchMedia = true) {
  type MediaListener = (event: { matches: boolean }) => void;
  const mediaListeners = new Set<MediaListener>();
  const media = {
    get matches() { return width <= 1440; },
    addEventListener: vi.fn((event: string, listener: MediaListener) => {
      if (event === "change") mediaListeners.add(listener);
    }),
    removeEventListener: vi.fn((event: string, listener: MediaListener) => {
      if (event === "change") mediaListeners.delete(listener);
    }),
  };
  const viewport = {
    ...(hasMatchMedia ? { matchMedia: vi.fn(() => media) } : {}),
  };
  const documentRoot = {} as FakeElement["ownerDocument"] & {
    defaultView: typeof viewport;
    addEventListener: (name: string, listener: () => void) => void;
    removeEventListener: (name: string, listener: () => void) => void;
  };
  const documentListeners = new Map<string, Set<() => void>>();
  documentRoot.addEventListener = (name, listener) => {
    const listeners = documentListeners.get(name) ?? new Set();
    listeners.add(listener);
    documentListeners.set(name, listeners);
  };
  documentRoot.removeEventListener = (name, listener) => documentListeners.get(name)?.delete(listener);
  documentRoot.defaultView = viewport;
  documentRoot.createElement = (tag) => new HomeWidgetElement(tag, documentRoot);
  documentRoot.documentElement = documentRoot.createElement("html");
  documentRoot.body = documentRoot.createElement("body");
  documentRoot.documentElement.append(documentRoot.body);
  documentRoot.activeElement = documentRoot.body;
  const createElement = (tag: string) => documentRoot.createElement(tag) as HomeWidgetElement;
  const homeRegion = createElement("main");
  const root = createElement("div");
  const content = createElement("div");
  const sourceParent = createElement("section");
  const source = createElement("section");
  const action = createElement("button");
  const following = createElement("section");
  const composer = createElement("textarea");
  source.className = "existing-component";
  sourceParent.className = "existing-component-parent";
  action.setAttribute("data-existing-action", "request-123");
  action.textContent = "Open request";
  source.append(action);
  sourceParent.append(source, following);
  content.append(sourceParent);
  composer.value = "Keep my unsent draft";
  root.append(content, composer);
  homeRegion.append(root);
  documentRoot.body.append(homeRegion);
  const actionListener = vi.fn();
  root.addEventListener("click", (event) => {
    const clicked = event.target.closest("[data-existing-action]");
    if (clicked) actionListener(clicked.dataset.existingAction);
  });

  return {
    root, content, homeRegion, sourceParent, source, following, action, composer,
    documentRoot, viewport, media, mediaListeners, actionListener, createElement,
    button: (id = "computer") => root.querySelector(`[data-home-widget="${id}"]`) as HomeWidgetElement | null,
    dialog: () => root.querySelector("dialog.home-widget-dialog") as HomeWidgetElement | null,
    resize(nextWidth: number) {
      const previous = media.matches;
      width = nextWidth;
      if (previous === media.matches) return;
      for (const listener of mediaListeners) listener({ matches: media.matches });
    },
  };
}
