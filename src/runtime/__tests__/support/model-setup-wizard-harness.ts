import { vi } from "vitest";
import {
  createModelSetupWizard,
  type ModelSetupWizardDependencies,
} from "../../../web-ui/app/components/model-setup/wizard.js";

const decode = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const voidTags = new Set(["INPUT", "BR", "HR"]);
type FakeDocument = {
  activeElement: FakeElement | null;
  body: FakeElement;
  documentElement: FakeElement;
  createElement: (tag: string) => FakeElement;
};

export class FakeElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(event: any) => void>>();
  readonly dataset: Record<string, string> = {};
  children: Array<FakeElement | string> = [];
  parentElement: FakeElement | null = null;
  hidden = false;
  inert = false;
  disabled = false;
  required = false;
  open = false;
  scrollTop = 0;
  readCount = 0;
  private rawValue = "";
  constructor(
    tag: string,
    readonly ownerDocument: FakeDocument,
  ) {
    this.tagName = tag.toUpperCase();
  }
  get value() {
    this.readCount += 1;
    return this.rawValue;
  }
  set value(value: string) {
    this.rawValue = value;
  }
  get type() {
    return this.attributes.get("type") || "";
  }
  get className() {
    return this.attributes.get("class") || "";
  }
  set className(value: string) {
    this.attributes.set("class", value);
  }
  get textContent(): string {
    return this.children
      .map((child) => (typeof child === "string" ? child : child.textContent))
      .join("");
  }
  set textContent(value: string) {
    this.children = [value];
  }
  get innerHTML(): string {
    return this.children
      .map((child) =>
        typeof child === "string" ? escape(child) : child.outerHTML,
      )
      .join("");
  }
  set innerHTML(value: string) {
    for (const child of this.children)
      if (typeof child !== "string") child.parentElement = null;
    this.children = [];
    const stack: FakeElement[] = [this];
    for (const token of value.matchAll(/<\/?[A-Za-z][^>]*>|[^<]+/g)) {
      const text = token[0];
      if (text.startsWith("</")) {
        stack.pop();
        continue;
      }
      if (!text.startsWith("<")) {
        stack.at(-1)!.children.push(decode(text));
        continue;
      }
      const tag = text.match(/^<([A-Za-z][\w-]*)/)![1];
      const node = new FakeElement(tag, this.ownerDocument);
      const attrs = text.slice(tag.length + 1, -1);
      for (const attr of attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g))
        node.setAttribute(attr[1], decode(attr[2] || ""));
      stack.at(-1)!.append(node);
      if (!voidTags.has(node.tagName)) stack.push(node);
    }
  }
  get outerHTML(): string {
    const attrs = new Map(this.attributes);
    for (const [name, enabled] of [
      ["hidden", this.hidden],
      ["inert", this.inert],
      ["disabled", this.disabled],
      ["required", this.required],
    ] as const) {
      if (enabled) attrs.set(name, "");
      else attrs.delete(name);
    }
    const attributes = [...attrs]
      .map(([name, value]) => ` ${name}="${escape(value)}"`)
      .join("");
    return `<${this.tagName.toLowerCase()}${attributes}>${voidTags.has(this.tagName) ? "" : `${this.innerHTML}</${this.tagName.toLowerCase()}>`}`;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name.startsWith("data-"))
      this.dataset[
        name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
      ] = value;
    if (name === "value") this.rawValue = value;
    if (name === "hidden") this.hidden = true;
    if (name === "inert") this.inert = true;
    if (name === "disabled") this.disabled = true;
    if (name === "required") this.required = true;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === "required") this.required = false;
  }
  append(node: FakeElement) {
    node.remove();
    this.children.push(node);
    node.parentElement = this;
  }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter(
        (child) => child !== this,
      );
    this.parentElement = null;
  }
  replaceChildren() {
    this.innerHTML = "";
  }
  contains(node: FakeElement | null): boolean {
    return (
      node === this ||
      this.children.some(
        (child) => typeof child !== "string" && child.contains(node),
      )
    );
  }
  matches(selector: string): boolean {
    const tag = selector.match(/^[A-Za-z][\w-]*/)?.[0];
    if (tag && tag.toUpperCase() !== this.tagName) return false;
    const className = selector.match(/\.([\w-]+)/)?.[1];
    if (className && !this.className.split(/\s+/).includes(className))
      return false;
    for (const attr of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g))
      if (
        !this.attributes.has(attr[1]) ||
        (attr[2] !== undefined && this.attributes.get(attr[1]) !== attr[2])
      )
        return false;
    return true;
  }
  closest(selector: string): FakeElement | null {
    return this.matches(selector)
      ? this
      : this.parentElement?.closest(selector) || null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((child) =>
      typeof child === "string"
        ? []
        : [
            ...(child.matches(selector) ? [child] : []),
            ...child.querySelectorAll(selector),
          ],
    );
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }
  focus = vi.fn(() => {
    if (!this.isBlocked()) this.ownerDocument.activeElement = this;
  });
  isBlocked(): boolean {
    return (
      this.hidden ||
      this.inert ||
      this.disabled ||
      Boolean(this.parentElement?.isBlocked())
    );
  }
  reportValidity() {
    const invalid = this.querySelectorAll("input").find(
      (input) => input.required && !input.rawValue.trim(),
    );
    invalid?.focus();
    return !invalid;
  }
  showModal() {
    this.open = true;
    this.ownerDocument.activeElement = this;
  }
  close() {
    this.open = false;
  }
  addEventListener(name: string, listener: (event: any) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), listener]);
  }
  dispatch(name: string) {
    const event = { target: this, preventDefault: vi.fn() };
    if (name !== "cancel" && this.isBlocked()) return event;
    let current: FakeElement | null = this;
    while (current) {
      for (const listener of current.listeners.get(name) || []) listener(event);
      current = current.parentElement;
    }
    return event;
  }
}

export const modelSetupCatalog = {
  providers: [
    {
      id: "local",
      type: "ollama",
      label: "Local Ollama",
      requiresApiKey: false,
      credentialConfigured: false,
    },
    {
      id: "cloud",
      type: "openai",
      label: "Cloud OpenAI",
      requiresApiKey: true,
      credentialConfigured: true,
    },
  ],
  profileIds: ["existing-model"],
  defaultContextWindowTokens: 32768,
};

export function createModelWizardHarness(
  overrides: Partial<ModelSetupWizardDependencies> = {},
) {
  const document = {} as FakeDocument;
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  document.documentElement.append(document.body);
  document.activeElement = document.body;
  const root = document.createElement("section");
  document.body.append(root);
  let locked = false;
  const requests: any[] = [];
  const loadSetup = vi.fn(async () => structuredClone(modelSetupCatalog));
  const saveModel = vi.fn(async (input: any) => {
    requests.push({ ...input });
    return {
      model: {
        profileId: input.profileId,
        providerId: input.providerId || input.newProvider.id,
        provider:
          input.newProvider?.type ||
          modelSetupCatalog.providers.find(
            (provider) => provider.id === input.providerId,
          )?.type ||
          "ollama",
        model: input.model,
      },
      restartRequired: true,
    };
  });
  const applySetup = vi.fn(async () => ({
    activation: { status: "ready" as const },
  }));
  const beginRuntimeMutation = vi.fn(() => {
    if (locked) return false;
    locked = true;
    return true;
  });
  const endRuntimeMutation = vi.fn(() => {
    locked = false;
  });
  const onSaved = vi.fn();
  const onComplete = vi.fn(async () => true);
  const onClosed = vi.fn();
  const wizard = createModelSetupWizard({
    root: root as unknown as HTMLElement,
    loadSetup,
    saveModel,
    applySetup,
    beginRuntimeMutation,
    endRuntimeMutation,
    onSaved,
    onComplete,
    onClosed,
    ...overrides,
  });
  const dialog = root.querySelector("dialog")!;
  const field = (id: string) =>
    dialog.querySelector(`[data-runtime-setup-field="${id}"]`);
  function input(id: string, value: string) {
    const element = field(id)!;
    element.value = value;
    element.dispatch("input");
  }
  function choose(value: string) {
    const element = dialog
      .querySelectorAll('[data-runtime-setup-field="provider"]')
      .find((entry) => entry.value === value)!;
    element.dispatch("change");
  }
  function click(action: string) {
    dialog.querySelector(`[data-model-action="${action}"]`)?.dispatch("click");
  }
  async function settled() {
    await vi.waitFor(() => {
      if (wizard.isBusy()) throw new Error("Busy");
    });
  }
  return {
    wizard,
    dialog,
    document,
    root,
    field,
    input,
    choose,
    click,
    settled,
    requests,
    dependencies: {
      loadSetup,
      saveModel,
      applySetup,
      beginRuntimeMutation,
      endRuntimeMutation,
      onSaved,
      onComplete,
      onClosed,
    },
    isLocked: () => locked,
  };
}
