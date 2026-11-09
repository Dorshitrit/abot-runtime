import { runInNewContext } from "node:vm";
import { Parser } from "htmlparser2";
import { expect, test, vi } from "vitest";
import { captureSparkHomeWidgetSlots } from "./spark-home-widget-slots.js";
import { sparkHomeWidgetGeometryScript, sparkHomeWidgetRelayScript } from "./spark-home-widget-bridge.js";
import { renderSparkHomeDocument, SPARK_HOME_CONTENT_POLICY } from "./spark-home-document.js";
import type { SparkHomeWidgetSlot } from "../../runtime/spark-home/widgets/catalog.js";
import { SPARK_HOME_WIDGET_CATALOG } from "../../runtime/spark-home/widgets/catalog.js";

const slots: readonly SparkHomeWidgetSlot[] = [
  { instanceId: "home-widget-1", widgetId: "memory-candidates", defaultHeight: 360 },
  { instanceId: "home-widget-2", widgetId: "skills", defaultHeight: 400 },
];
const executable = (markup: string) => markup.slice("<script>".length, -"</script>".length);
type Message = { source: unknown; data: Record<string, unknown> };

function canvasSource(markup: string): string {
  let source: string | undefined;
  new Parser({ onopentag(name, attributes) {
    if (name === "iframe") source = attributes.srcdoc;
  } }, { decodeEntities: true }).end(markup);
  if (source === undefined) throw new Error("Expected the generated canvas frame");
  return source;
}

function relayFixture() {
  const handlers = new Map<string, (event: Message) => void>();
  const parent = { postMessage: vi.fn() };
  const child = { postMessage: vi.fn() };
  runInNewContext(executable(sparkHomeWidgetRelayScript(7, slots)), {
    parent, document: { querySelector: () => ({ contentWindow: child }) },
    addEventListener: (name: string, handler: (event: Message) => void) => handlers.set(name, handler),
  });
  const send = (source: unknown, data: Record<string, unknown>) => handlers.get("message")!({ source, data });
  return { parent, child, handlers, send };
}

test("static slots bind only registered distinct divs and preserve existing authored markup", () => {
  const html = '<script>const text=`<div data-abot-widget="skills"></div>`;</script>'
    + '<template><div data-abot-widget="skills"></div></template>'
    + '<svg><foreignObject><div data-abot-widget="skills"></div></foreignObject></svg>'
    + '<div class="grid" data-abot-widget="memory-candidates"></div>'
    + '<div data-abot-widget="memory-candidates">duplicate</div>'
    + '<div data-abot-widget="unknown">unknown</div>'
    + '<div data-abot-widget="skills" data-abot-widget-slot="forged"></div>'
    + '<div data-abot-widget="skills"></div><div data-abot-widget="resources"></div>'
    + '<div data-abot-widget="feature-discovery"></div><section data-abot-widget="skills"></section>';
  const captured = captureSparkHomeWidgetSlots(html);
  expect(captured.slots.map(slot => slot.widgetId)).toEqual(["memory-candidates", "skills", "resources", "feature-discovery"]);
  expect(captured.slots.map(slot => slot.instanceId)).toEqual(["home-widget-1", "home-widget-2", "home-widget-3", "home-widget-4"]);
  expect(captured.html).toContain('class="grid" data-abot-widget="memory-candidates" data-abot-widget-slot="home-widget-1"');
  expect(captured.html.replace(/ data-abot-widget-slot="home-widget-\d"/g, "")).toBe(html);
});

test.each(["noscript", "iframe", "noembed", "noframes"])("%s text does not create slots or consume IDs for later visible widgets", tag => {
  const ignored = `<${tag}><div data-abot-widget="skills"></div></${tag}>`;
  const html = ignored + '<div data-abot-widget="skills"></div>';
  const captured = captureSparkHomeWidgetSlots(html);
  expect(captured.slots.map(slot => slot.widgetId)).toEqual(["skills"]);
  expect(captured.html.slice(0, ignored.length)).toBe(ignored);
  expect(captured.html.slice(ignored.length)).toContain('data-abot-widget-slot="home-widget-1"');
});

test.each(["noscript", "iframe", "noembed", "noframes"])("%s text cannot close ancestors or introduce nested parsing modes", tag => {
  const ignored = `<section><${tag} title="quoted > delimiter">`
    + '</section><script><plaintext><div data-abot-widget="skills"></div>'
    + `</${tag.toUpperCase()} >`;
  const visible = '<div data-abot-widget="skills"></div></section>';
  const captured = captureSparkHomeWidgetSlots(ignored + visible);
  expect(captured.slots.map(slot => slot.widgetId)).toEqual(["skills"]);
  expect(captured.html.slice(0, ignored.length)).toBe(ignored);
  expect(captured.html.slice(ignored.length)).toContain('data-abot-widget-slot="home-widget-1"');
});

test("plaintext consumes the remaining document even after a closing tag", () => {
  const before = '<div data-abot-widget="skills"></div>';
  const remainder = '<plaintext><div data-abot-widget="resources"></div></plaintext>'
    + '<div data-abot-widget="memory-candidates"></div>';
  const captured = captureSparkHomeWidgetSlots(before + remainder);
  expect(captured.slots.map(slot => slot.widgetId)).toEqual(["skills"]);
  expect(captured.html.endsWith(remainder)).toBe(true);
});

test("widget documents retain opaque nested frames and network restrictions", () => {
  const document = renderSparkHomeDocument('<div data-abot-widget="skills"></div>', 7);
  expect(document.match(/<iframe /g)).toHaveLength(1);
  expect(document).toContain('sandbox="allow-scripts"');
  expect(document).toContain('"revision":7');
  expect(document).not.toContain("allow-same-origin");
  expect(SPARK_HOME_CONTENT_POLICY).toContain("connect-src 'none'");
  expect(SPARK_HOME_CONTENT_POLICY).toContain("frame-src 'none'");
  expect(document.match(/<script>/g)).toHaveLength(1);
  const unchanged = captureSparkHomeWidgetSlots('<h1>Existing screen</h1>');
  expect(unchanged).toEqual({ html: '<h1>Existing screen</h1>', slots: [], firstSlotOffset: null });
  expect(renderSparkHomeDocument(unchanged.html, 7)).not.toContain("abot.spark-home-widgets");
  expect(canvasSource(renderSparkHomeDocument(unchanged.html, 7))).toBe(unchanged.html);
});

test.each([
  ["plaintext", "<plaintext>literal tail"],
  ["closed plaintext", "<plaintext>literal</plaintext>still text"],
  ...["textarea", "noscript", "iframe", "script", "style", "template"].map(tag => [tag, `<${tag}>unfinished tail`]),
  ["comment", "<!-- unfinished tail"],
])("the geometry bridge stays executable before terminal %s content", (_name, tail) => {
  const prefix = '<!doctype html>\n<html><head><title>Home</title></head><body>'
    + '<!-- <div data-abot-widget="spark-status" data-abot-widget-slot="home-widget-1"></div> -->'
    + '<template><div data-abot-widget="spark-status" data-abot-widget-slot="home-widget-1"></div></template><main>';
  const widgets = ["spark-status", "conversations", "approvals"].map(id => `<div data-abot-widget="${id}"></div>`).join("");
  const captured = captureSparkHomeWidgetSlots(prefix + widgets + tail);
  const bridge = sparkHomeWidgetGeometryScript(7, captured.slots);
  const source = canvasSource(renderSparkHomeDocument(prefix + widgets + tail, 7));
  expect(captured.slots.map(slot => slot.widgetId)).toEqual(["spark-status", "conversations", "approvals"]);
  expect(source.slice(0, prefix.length)).toBe(prefix);
  expect(source.slice(prefix.length, prefix.length + bridge.length)).toBe(bridge);
  expect(source.slice(prefix.length + bridge.length)).toBe(captured.html.slice(prefix.length));
  expect(source.endsWith(tail)).toBe(true);
  expect(captured.firstSlotOffset).toBe(prefix.length);
});

test("all six Dashboard slots can coexist with the four optional management slots", () => {
  const ids = SPARK_HOME_WIDGET_CATALOG.entries.filter(widget => widget.group !== "monitoring").map(widget => widget.id);
  const html = ids.map(id => `<div data-abot-widget="${id}"></div>`).join("")
    + '<div data-abot-widget="approvals"></div><div data-abot-widget="unknown"></div>';
  const captured = captureSparkHomeWidgetSlots(html);
  expect(captured.slots.map(slot => slot.widgetId)).toEqual(ids);
  expect(captured.slots.at(-1)?.instanceId).toBe("home-widget-10");
  expect(captured.html.replace(/ data-abot-widget-slot="home-widget-\d+"/g, "")).toBe(html);
});

test("outer bridge publishes the canonical manifest and strips unknown IDs, action fields and invalid geometry", () => {
  const f = relayFixture();
  f.handlers.get("DOMContentLoaded")!({ source: null, data: {} });
  expect(f.parent.postMessage).toHaveBeenLastCalledWith({ kind: "abot.spark-home-widgets", version: 1, revision: 7,
    slots: slots.map(slot => ({ instanceId: slot.instanceId, widgetId: slot.widgetId, rect: null })) }, "*");
  const data = { kind: "abot.spark-home-widget-geometry", version: 1, revision: 7, entries: [
    { instanceId: "home-widget-1", widgetId: "resources", x: 10, y: -20, width: 300, height: 360, action: "delete", secret: "hidden" },
    { instanceId: "home-widget-2", x: 0, y: 0, width: Infinity, height: 400 },
  ] };
  f.send(f.child, data);
  expect(f.parent.postMessage).toHaveBeenLastCalledWith({ kind: "abot.spark-home-widgets", version: 1, revision: 7, slots: [
    { instanceId: "home-widget-1", widgetId: "memory-candidates", rect: { x: 10, y: -20, width: 300, height: 360 } },
    { instanceId: "home-widget-2", widgetId: "skills", rect: null },
  ] }, "*");
  const calls = f.parent.postMessage.mock.calls.length;
  f.send({}, data);
  f.send(f.child, { ...data, revision: 6 });
  f.send(f.child, { ...data, entries: [...data.entries, data.entries[0]] });
  f.send(f.child, { ...data, kind: "abot.spark-home-widget-action" });
  expect(f.parent.postMessage).toHaveBeenCalledTimes(calls);
  f.send(f.child, { ...data, entries: [{ instanceId: "unknown", x: 1, y: 1, width: 200, height: 200 }] });
  expect(f.parent.postMessage.mock.calls.at(-1)![0].slots.every((slot: { rect: unknown }) => slot.rect === null)).toBe(true);
});

test("only the exact host can send bounded numeric sizes; arbitrary data and actions never reach the child", () => {
  const f = relayFixture();
  const data = { kind: "abot.spark-home-widget-sizing", version: 1, revision: 7, sizes: [
    { instanceId: "home-widget-1", height: 0, contents: "private memory", action: "save" },
    { instanceId: "home-widget-2", height: 601 },
  ] };
  f.send(f.child, data);
  f.send({}, data);
  f.send(f.parent, { ...data, revision: 6 });
  expect(f.child.postMessage).not.toHaveBeenCalled();
  f.send(f.parent, data);
  expect(f.child.postMessage).toHaveBeenCalledExactlyOnceWith({ kind: "abot.spark-home-widget-sizing", version: 1, revision: 7,
    sizes: [{ instanceId: "home-widget-1", height: 0 }] }, "*");
});

test("inner reporter reserves host height, sends only rectangle data, and accepts collapse only from its parent", () => {
  const handlers = new Map<string, (event: Message) => void>();
  const queued: (() => void)[] = [];
  const parent = { postMessage: vi.fn() };
  const node = { isConnected: true, style: {} as Record<string, string>,
    getBoundingClientRect: () => ({ x: 12, y: 30, width: 320, height: Number.parseFloat(node.style.height), secret: "not transported" }) };
  class Observer { observe() {} }
  runInNewContext(executable(sparkHomeWidgetGeometryScript(7, slots.slice(0, 1))), {
    parent, document: { readyState: "complete", querySelector: () => node, documentElement: {} }, MutationObserver: Observer, ResizeObserver: Observer,
    addEventListener: (name: string, handler: (event: Message) => void) => handlers.set(name, handler),
    requestAnimationFrame: (callback: () => void) => queued.push(callback),
  });
  expect(node.style.height).toBe("360px");
  queued.shift()!();
  expect(parent.postMessage).toHaveBeenLastCalledWith({ kind: "abot.spark-home-widget-geometry", version: 1, revision: 7,
    entries: [{ instanceId: "home-widget-1", x: 12, y: 30, width: 320, height: 360 }] }, "*");
  const data = { kind: "abot.spark-home-widget-sizing", version: 1, revision: 7, sizes: [{ instanceId: "home-widget-1", height: 0 }] };
  handlers.get("message")!({ source: {}, data });
  expect(node.style.height).toBe("360px");
  handlers.get("message")!({ source: parent, data });
  expect(node.style.height).toBe("0px");
  queued.shift()!();
  expect(parent.postMessage.mock.calls.at(-1)![0].entries[0].height).toBe(0);
});


test("an early bridge initializes all slots once after the DOM is ready", () => {
  const manifest = captureSparkHomeWidgetSlots(["spark-status", "conversations", "approvals"]
    .map(id => `<div data-abot-widget="${id}"></div>`).join("")).slots;
  const nodes = manifest.map((_slot, index) => {
    const node = { isConnected: true, style: {} as Record<string, string>,
      getBoundingClientRect: () => ({ x: index * 12, y: 30, width: 320, height: Number.parseFloat(node.style.height) }) };
    return node;
  });
  const selectors = new Map(manifest.map((slot, index) => [`[data-abot-widget-slot="${slot.instanceId}"]`, nodes[index]]));
  const querySelector = vi.fn((selector: string) => selectors.get(selector) || null);
  const document = { readyState: "loading", querySelector, documentElement: {} };
  const observe = vi.fn(); const constructed = vi.fn();
  class Observer { constructor() { constructed(); } observe = observe; }
  const handlers = new Map<string, { listener: () => void; once: boolean }>();
  const queued: (() => void)[] = [];
  const parent = { postMessage: vi.fn() };
  runInNewContext(executable(sparkHomeWidgetGeometryScript(7, manifest)), {
    document, parent, MutationObserver: Observer, ResizeObserver: Observer,
    addEventListener: (name: string, listener: () => void, options?: { once?: boolean }) => {
      handlers.set(name, { listener, once: options?.once === true });
    },
    requestAnimationFrame: (callback: () => void) => queued.push(callback),
  });
  expect(querySelector).not.toHaveBeenCalled();
  expect(constructed).not.toHaveBeenCalled();
  expect(queued).toHaveLength(0);
  expect(nodes.every(node => node.style.height === undefined)).toBe(true);
  document.readyState = "interactive";
  for (let event = 0; event < 2; event += 1) {
    const ready = handlers.get("DOMContentLoaded");
    if (!ready) continue;
    if (ready.once) handlers.delete("DOMContentLoaded");
    ready.listener();
  }
  expect(querySelector).toHaveBeenCalledTimes(3);
  expect(nodes.map(node => node.style.height)).toEqual(["200px", "200px", "200px"]);
  expect(observe).toHaveBeenCalledWith(document.documentElement, expect.anything());
  expect(queued).toHaveLength(1);
  queued.shift()!();
  expect(parent.postMessage).toHaveBeenCalledExactlyOnceWith({ kind: "abot.spark-home-widget-geometry", version: 1, revision: 7,
    entries: manifest.map((slot, index) => ({ instanceId: slot.instanceId, x: index * 12, y: 30, width: 320, height: 200 })) }, "*");
});
