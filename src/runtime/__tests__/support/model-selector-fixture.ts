import { vi } from "vitest";
import { createModelSelector } from "../../../web-ui/app/components/model-selector.js";
import { ContextElement } from "./composer-context-window-dom.js";

export type ModelSelectorOption = {
  value: string;
  label: string;
  disabled?: boolean;
  dataset?: Record<string, string>;
};

class ModelSelectorElement extends ContextElement {
  value = "";
  title = "";
  options: ModelSelectorOption[] = [];

  constructor(tagName: string, private readonly owner: ModelSelectorDocument) {
    super(tagName);
  }

  focus() { this.owner.activeElement = this; }

  replaceChildren(...children: ContextElement[]) {
    const focused = this.owner.activeElement;
    if (this.children.some((child) => child.contains(focused))) this.owner.activeElement = null;
    super.replaceChildren(...children);
  }

  dispatchEvent(event: Event) {
    this.dispatch(event.type, { target: this });
    return true;
  }

  getAttribute(name: string): string | null {
    if (!name.startsWith("data-")) return super.getAttribute(name);
    const key = name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    return this.dataset[key] ?? super.getAttribute(name);
  }

  setAttribute(name: string, value: string) {
    super.setAttribute(name, value);
    if (!name.startsWith("data-")) return;
    const key = name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    this.dataset[key] = value;
  }

  matches(selector: string): boolean {
    if (selector.includes(":not(:disabled)") && this.disabled) return false;
    const attributes = [...selector.matchAll(/\[([^=\]]+)="([^"]*)"\]/g)];
    if (attributes.length > 0)
      return attributes.every(([, name, value]) => this.getAttribute(name) === value);
    return super.matches(selector);
  }

  querySelectorAll(selector: string): ModelSelectorElement[] {
    return this.children.flatMap((element) => {
      const child = element as ModelSelectorElement;
      return [
        ...(child.matches(selector) ? [child] : []),
        ...child.querySelectorAll(selector),
      ];
    });
  }

  querySelector(selector: string): ModelSelectorElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class ModelSelectorDocument {
  activeElement: ModelSelectorElement | null = null;
  readonly root = new ModelSelectorElement("document", this);
  readonly addEventListener = this.root.addEventListener.bind(this.root);
  readonly createElement = (tagName: string) => new ModelSelectorElement(tagName, this);
}

export function modelSelectorFixture(
  options: readonly ModelSelectorOption[],
  selected = options[0]?.value ?? "",
  disabled = false,
) {
  const documentRoot = new ModelSelectorDocument();
  const composer = documentRoot.createElement("div");
  composer.className = "composer";
  const select = documentRoot.createElement("select");
  select.options = options.map((option) => ({
    ...option, disabled: option.disabled ?? false, dataset: { ...option.dataset },
  }));
  select.value = selected;
  select.disabled = disabled;
  const button = documentRoot.createElement("button");
  const valueLabel = documentRoot.createElement("span");
  const menu = documentRoot.createElement("div");
  button.append(valueLabel);
  composer.append(select, button, menu);
  documentRoot.root.append(composer);
  const changed = vi.fn();
  const onOpen = vi.fn();
  select.addEventListener("change", changed);
  const selector = createModelSelector({
    select: select as unknown as HTMLSelectElement,
    button: button as unknown as HTMLButtonElement,
    valueLabel: valueLabel as unknown as HTMLElement,
    menu: menu as unknown as HTMLElement,
    documentRoot: documentRoot as unknown as Document,
    viewport: {
      requestAnimationFrame(callback: FrameRequestCallback) { callback(0); return 1; },
    } as unknown as Window,
    onOpen,
  });
  selector.bind();
  const items = () => menu.querySelectorAll('[role="menuitemradio"]');
  const item = (value: string) => {
    const element = items().find((candidate) => candidate.dataset.modelId === value);
    if (!element) throw new Error(`Missing model option: ${value}`);
    return element;
  };
  const providers = () => menu.querySelectorAll(".model-select-provider-option");
  const provider = (id: string) => {
    const element = providers().find((candidate) => candidate.dataset.providerId === id);
    if (!element) throw new Error(`Missing provider option: ${id}`);
    return element;
  };
  const backButton = () => {
    const element = menu.querySelector(".model-select-back");
    if (!element) throw new Error("Missing model selector back button");
    return element;
  };
  const event = (target: ModelSelectorElement, key = "") => ({
    target, key, preventDefault: vi.fn(), stopPropagation: vi.fn(),
  });
  return {
    documentRoot, composer, select, button, valueLabel, menu, selector, changed,
    onOpen, items, item, providers, provider, backButton,
    open: () => button.dispatch("click", event(button)),
    browse: (id: string) => provider(id).dispatch("click", event(provider(id))),
    back: () => backButton().dispatch("click", event(backButton())),
    choose: (value: string) => item(value).dispatch("click", event(item(value))),
    key: (key: string) => menu.dispatch("keydown", event(menu, key)),
  };
}
