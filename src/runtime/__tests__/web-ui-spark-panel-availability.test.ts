import { beforeEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser component.
import { createSparkChatPanel } from "../../web-ui/app/components/spark-chat/panel.js";

const placement = vi.hoisted(() => ({ hiddenAtRestore: false }));
vi.mock("../../web-ui/app/components/spark-chat/placement.js", () => ({
  createSparkChatPlacement: ({ root, launcher }: any) => {
    placement.hiddenAtRestore = launcher.hidden;
    root.ownerDocument.body.append(launcher);
    return { refresh: vi.fn(), reset: vi.fn() };
  },
}));

class ElementStub extends EventTarget {
  hidden = false; textContent = ""; innerHTML = ""; className = "";
  dataset: Record<string, string> = {};
  parentNode: ElementStub | null = null;
  attributes = new Map<string, string>();
  constructor(readonly ownerDocument: any) { super(); }
  append(node: ElementStub) { node.parentNode = this; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  insertAdjacentHTML = vi.fn();
  focus = vi.fn();
  querySelectorAll = (_selector: string): ElementStub[] => [];
  querySelector = (_selector: string): ElementStub | null => null;
}

function fixture() {
  const documentRoot: any = { activeElement: null };
  documentRoot.body = new ElementStub(documentRoot);
  const panel = new ElementStub(documentRoot), notice = new ElementStub(documentRoot);
  panel.hidden = true; notice.hidden = true;
  const names = ["launcherButton", "messagesList", "composerInput", "closeButton", "mascotButton", "noticeButton", "dismissNoticeButton", "sendNextMenu", "unreadBadge"];
  const nodes = Object.fromEntries(names.map((name) => {
    const node = new ElementStub(documentRoot); node.dataset.spark = name;
    return [name, node];
  }));
  documentRoot.createElement = (tag: string) => {
    const node = new ElementStub(documentRoot);
    if (tag !== "aside") return node;
    node.querySelectorAll = () => Object.values(nodes);
    node.querySelector = (selector) => selector === ".spark-chat-panel" ? panel : notice;
    return node;
  };
  const component = createSparkChatPanel({ documentRoot });
  return { component, nodes, documentRoot };
}

beforeEach(() => { placement.hiddenAtRestore = false; });

test("a restored floating launcher stays hidden before availability is resolved", () => {
  const f = fixture();
  expect(f.nodes.launcherButton!.parentNode).toBe(f.documentRoot.body);
  expect(placement.hiddenAtRestore).toBe(true);
  expect(f.nodes.launcherButton!.hidden).toBe(true);
  expect(f.component.root.hidden).toBe(true);
  f.component.setAvailable(true);
  expect(f.nodes.launcherButton!.hidden).toBe(false);
  f.nodes.launcherButton!.dispatchEvent(new Event("click"));
  expect(f.component.isOpen()).toBe(true);
  f.component.setAvailable(false);
  expect(f.nodes.launcherButton!.hidden).toBe(true);
  expect(f.component.root.hidden).toBe(true);
  expect(f.component.isOpen()).toBe(false);
});
