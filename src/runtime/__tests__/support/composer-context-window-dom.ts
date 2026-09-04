type ContextPointerEvent = {
  key?: string;
  relatedTarget?: ContextElement | null;
  target?: ContextElement;
  preventDefault?: () => void;
  stopPropagation?: () => void;
};

export class ContextElement {
  readonly children: ContextElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<
    string,
    Array<(event: ContextPointerEvent) => void>
  >();
  readonly dataset: Record<string, string> = {};
  private readonly styleProperties = new Map<string, string>();
  private ownText = "";
  className = "";
  id = "";
  type = "";
  hidden = false;
  disabled = false;
  tabIndex = 0;
  parentElement: ContextElement | null = null;

  constructor(readonly tagName: string) {}

  readonly classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    toggle: (name: string, active = !this.classList.contains(name)) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      if (active) names.add(name);
      if (!active) names.delete(name);
      this.className = [...names].join(" ");
      return active;
    },
    add: (name: string) => this.classList.toggle(name, true),
    remove: (name: string) => this.classList.toggle(name, false),
  };

  readonly style = {
    setProperty: (name: string, value: string) => {
      this.styleProperties.set(name, value);
    },
    getPropertyValue: (name: string) => this.styleProperties.get(name) ?? "",
    removeProperty: (name: string) => this.styleProperties.delete(name),
  };

  get textContent(): string {
    return (
      this.ownText + this.children.map((child) => child.textContent).join("")
    );
  }

  set textContent(value: string) {
    this.replaceChildren();
    this.ownText = value;
  }

  appendChild(child: ContextElement) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...children: ContextElement[]) {
    for (const child of children) this.appendChild(child);
  }

  replaceChildren(...children: ContextElement[]) {
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
    this.ownText = "";
    this.append(...children);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  addEventListener(
    name: string,
    listener: (event: ContextPointerEvent) => void,
  ) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  dispatch(name: string, event: ContextPointerEvent = {}) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  contains(candidate: ContextElement | null): boolean {
    if (!candidate) return false;
    if (candidate === this) return true;
    return this.contains(candidate.parentElement);
  }

  matches(selector: string) {
    if (selector.startsWith("."))
      return this.classList.contains(selector.slice(1));
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  querySelector(selector: string): ContextElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const descendant = child.querySelector(selector);
      if (descendant) return descendant;
    }
    return null;
  }
}

export function createComposerContextDom() {
  const container = new ContextElement("div");
  container.id = "composerContextWindow";
  const eventTarget = new ContextElement("document");
  const documentRoot = {
    activeElement: null as ContextElement | null,
    createElement: (tagName: string) => new ContextElement(tagName),
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    dispatch: eventTarget.dispatch.bind(eventTarget),
  };
  return { container, documentRoot };
}
