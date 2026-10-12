import { vi } from "vitest";
import { FakeElement } from "./model-setup-wizard-harness.js";

/** DOM ownership and native event dispatch for the SPARK production composition. */
export class SparkElement extends FakeElement {
  private events = new EventTarget();
  style = { height: "" };
  scrollHeight = 32;
  override get type() { return this.attributes.get("type") || ""; }
  set type(value: string) { this.attributes.set("type", value); }
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    toggle: (name: string, enabled = !this.classList.contains(name)) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      if (enabled) names.add(name);
      else names.delete(name);
      this.className = [...names].join(" ");
      return enabled;
    },
    add: (name: string) => { this.classList.toggle(name, true); },
    remove: (name: string) => { this.classList.toggle(name, false); },
  };
  appendChild(child: FakeElement) { this.append(child); return child; }
  override addEventListener(name: string, listener: (event: any) => void) {
    this.events.addEventListener(name, listener);
  }
  dispatchEvent(event: Event) { return this.events.dispatchEvent(event); }
}

export function installSparkDocument() {
  const owner: any = { activeElement: null, defaultView: { Event } };
  owner.createElement = (tag: string) => new SparkElement(tag, owner);
  const root = Object.assign(owner.createElement("document"), owner);
  vi.stubGlobal("document", root);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { setTimeout, requestAnimationFrame: vi.fn() }));
  return root;
}

export function sparkDom() {
  const nodes: Record<PropertyKey, SparkElement> = {};
  const element = (key: PropertyKey) => nodes[key] ??= document.createElement(key === "composerForm" ? "form" : "div") as unknown as SparkElement;
  for (const key of ["attachmentButton", "attachmentInput", "attachmentPreview", "composerForm", "composerInput",
    "composerSubmitControl", "jumpToLatestButton", "messageStatusRegion", "messagesList", "sendButton", "sendButtonLabel",
    "sendNextButton", "sendNextMenu", "sendNextMenuButton", "stopButton"]) element(key);
  return new Proxy(nodes as Record<string, SparkElement>, { get: (_target, key) => element(key) });
}
