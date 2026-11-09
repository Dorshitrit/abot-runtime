import { afterEach, expect, test, vi } from "vitest";
import { ContextElement } from "../../runtime/__tests__/support/composer-context-window-dom.js";
import type { SystemMetricsSnapshot } from "./contracts.js";
// @ts-expect-error Browser-only component.
import { createSystemMetricsCard } from "../app/components/system-widgets/metrics-card.js";
// @ts-expect-error Browser-only lifecycle owner.
import { createSystemMetricsMounts } from "../app/components/system-widgets/metrics-mounts.js";
// @ts-expect-error Browser-only poller.
import { createSystemMetricsController } from "../app/controllers/system-metrics-controller.js";

afterEach(() => vi.useRealTimers());

const sample: SystemMetricsSnapshot = {
  sampledAt: "2026-11-06T12:00:00Z", scope: { kind: "computer", platform: "darwin", withinWsl: false },
  cpu: { percent: 25, capacity: 8, reason: null },
  memory: { usedBytes: 16 * 1024 ** 3, totalBytes: 64 * 1024 ** 3, percent: 25, basis: "free" },
  temperature: { celsius: null, sensor: null, reason: "unsupported", scope: null },
};

class MetricsElement extends ContextElement {
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1); this.parentElement = null;
  }
}
function domFixture() {
  const documentRoot = { visibilityState: "visible", createElement: (tag: string) => new MetricsElement(tag), defaultView: {} };
  const root = new MetricsElement("div"); const sibling = new MetricsElement("section");
  sibling.textContent = "Unrelated HOME content";
  const home = new MetricsElement("main"); home.append(root, sibling);
  return { documentRoot, root, home, sibling };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function descendants(node: ContextElement): ContextElement[] {
  return [node, ...node.children.flatMap(descendants)];
}

test("1,000 sample ticks retain all structural DOM nodes, sibling state and root identity", () => {
  const f = domFixture(); const card = createSystemMetricsCard(f.root, f.documentRoot);
  card.render({ status: "live", metrics: sample });
  const original = descendants(f.home);
  const rootChanges = vi.spyOn(f.root, "replaceChildren");
  const siblingChanges = vi.spyOn(f.sibling, "replaceChildren");
  const containerChanges = vi.spyOn(f.home, "replaceChildren");
  for (let i = 0; i < 1000; i += 1) card.render({ status: "live", metrics: { ...sample,
    cpu: { ...sample.cpu, percent: i % 100 }, memory: { ...sample.memory, percent: i % 80 } } });
  const current = descendants(f.home);
  expect(current).toHaveLength(original.length);
  current.forEach((node, index) => expect(node).toBe(original[index]));
  expect(rootChanges).not.toHaveBeenCalled(); expect(siblingChanges).not.toHaveBeenCalled(); expect(containerChanges).not.toHaveBeenCalled();
  expect(f.root.querySelector(".system-metrics-fill")!.style.getPropertyValue("transform")).toBe("scaleX(0.990)");
  expect(f.sibling.textContent).toBe("Unrelated HOME content");
  card.dispose(); expect(f.root.children).toHaveLength(0);
});

test("an identical sample makes zero DOM/attribute/style writes", () => {
  const f = domFixture(); const card = createSystemMetricsCard(f.root, f.documentRoot);
  card.render({ status: "live", metrics: sample });
  const writes = descendants(f.root).flatMap(node => [vi.spyOn(node, "textContent", "set"),
    vi.spyOn(node, "setAttribute"), vi.spyOn(node.style, "setProperty"), vi.spyOn(node, "removeAttribute")]);
  card.render({ status: "live", metrics: sample });
  for (const write of writes) expect(write).not.toHaveBeenCalled();
});

test.each([
  ["darwin", "vm_stat", "Memory used"], ["darwin", "free", "Memory incl. cache"],
  ["linux", "available", "Memory used"], ["linux", "cgroup", "Memory incl. cache"],
  ["linux", "free", "Memory incl. cache"], ["win32", "free", "Memory used"],
])("memory labels explain whether %s/%s includes cache", (platform, basis, label) => {
  const f = domFixture(); const card = createSystemMetricsCard(f.root, f.documentRoot);
  card.render({ status: "live", metrics: { ...sample, scope: { ...sample.scope, platform }, memory: { ...sample.memory, basis } } });
  expect(f.root.textContent).toContain(label);
  expect(descendants(f.root).filter(node => node.getAttribute("role") === "meter")[1].getAttribute("aria-label")).toBe(label);
});

test("scope and host sensor labels remain distinct and a failed read removes stale values", () => {
  const f = domFixture(); const card = createSystemMetricsCard(f.root, f.documentRoot);
  card.render({ status: "live", metrics: { ...sample, scope: { kind: "container", platform: "linux", withinWsl: true },
    temperature: { celsius: 65, sensor: "coretemp", scope: "computer", reason: null } } });
  expect(f.root.querySelector(".system-metrics-scope")!.textContent).toBe("Container · WSL");
  expect(f.root.textContent).toContain("65.0 °C");
  const temperature = f.root.querySelector(".system-metrics-temperature")!.children[1];
  expect(temperature.getAttribute("title")).toContain("Physical computer sensor");
  card.render({ status: "unavailable", metrics: null });
  expect(f.root.textContent).not.toContain("65.0"); expect(f.root.textContent).not.toContain("25%");
  expect(f.root.textContent).toContain("Unavailable");
});

test("polling is serial, stops on leave, aborts in-flight work and rejects late results", async () => {
  vi.useFakeTimers();
  const first = deferred<{ metrics: SystemMetricsSnapshot }>();
  const client = { getSystemMetrics: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({ metrics: sample }) };
  const render = vi.fn();
  const controller = createSystemMetricsController({ client, getEnvironmentId: () => "dev", render });
  await vi.advanceTimersByTimeAsync(10_000); expect(client.getSystemMetrics).not.toHaveBeenCalled();
  controller.setActive(true); await vi.advanceTimersByTimeAsync(4000);
  expect(client.getSystemMetrics).toHaveBeenCalledOnce();
  const signal = client.getSystemMetrics.mock.calls[0][1].signal as AbortSignal;
  controller.setActive(false); expect(signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  first.resolve({ metrics: sample }); await vi.advanceTimersByTimeAsync(10_000);
  expect(render).not.toHaveBeenCalledWith(expect.objectContaining({ status: "live" }));
  expect(client.getSystemMetrics).toHaveBeenCalledOnce();
  controller.setActive(true); await vi.advanceTimersByTimeAsync(0);
  expect(client.getSystemMetrics).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2000); expect(client.getSystemMetrics).toHaveBeenCalledTimes(3);
  controller.destroy(); await vi.advanceTimersByTimeAsync(20_000);
  expect(client.getSystemMetrics).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
});

test("environment changes invalidate old responses and subsequent polls bind the new environment", async () => {
  vi.useFakeTimers(); let environment = "dev";
  const old = deferred<{ metrics: SystemMetricsSnapshot }>();
  const client = { getSystemMetrics: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ metrics: sample }) };
  const render = vi.fn();
  const controller = createSystemMetricsController({ client, getEnvironmentId: () => environment, render });
  controller.setActive(true); environment = "prod"; controller.environmentChanged();
  old.resolve({ metrics: sample }); await vi.advanceTimersByTimeAsync(0);
  expect(render).not.toHaveBeenCalledWith(expect.objectContaining({ status: "live" }));
  await vi.advanceTimersByTimeAsync(2000);
  expect(client.getSystemMetrics.mock.calls.map(call => call[0])).toEqual(["dev", "prod"]);
  controller.destroy();
});

test("a timed-out read becomes unavailable and the next bounded poll can recover", async () => {
  vi.useFakeTimers();
  const client = { getSystemMetrics: vi.fn().mockImplementationOnce((_environment, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })).mockResolvedValue({ metrics: sample }) };
  const render = vi.fn();
  const controller = createSystemMetricsController({ client, getEnvironmentId: () => "dev", render });
  controller.setActive(true); await vi.advanceTimersByTimeAsync(5000);
  expect(render).toHaveBeenLastCalledWith({ metrics: null, status: "unavailable" });
  expect(client.getSystemMetrics).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2000);
  expect(render).toHaveBeenLastCalledWith({ metrics: sample, status: "live" });
  controller.destroy(); expect(vi.getTimerCount()).toBe(0);
});

test("visibility, intersection, geometry, environment and final unmount control a single poller", async () => {
  vi.useFakeTimers(); const f = domFixture(); let environment = "dev";
  let intersect!: (entries: unknown[]) => void;
  const disconnect = vi.fn();
  class Observer {
    constructor(callback: typeof intersect) { intersect = callback; }
    observe() {} disconnect = disconnect;
  }
  const client = { getSystemMetrics: vi.fn(async () => ({ metrics: sample })) };
  const mounts = createSystemMetricsMounts({ ...f, client, getEnvironmentId: () => environment, isAvailable: () => true, Observer });
  const height = vi.fn(); const view = mounts.mount(f.root, height); mounts.setActive(true);
  await vi.advanceTimersByTimeAsync(3000); expect(client.getSystemMetrics).not.toHaveBeenCalled();
  intersect([{ target: f.root, isIntersecting: true }]); await vi.advanceTimersByTimeAsync(4000);
  expect(client.getSystemMetrics).toHaveBeenCalledTimes(3); expect(height).toHaveBeenCalledExactlyOnceWith(280);
  f.documentRoot.visibilityState = "hidden"; mounts.visibilityChanged();
  await vi.advanceTimersByTimeAsync(10_000); expect(client.getSystemMetrics).toHaveBeenCalledTimes(3);
  f.documentRoot.visibilityState = "visible"; mounts.visibilityChanged(); await vi.advanceTimersByTimeAsync(0);
  expect(client.getSystemMetrics).toHaveBeenCalledTimes(4);
  view.setVisible(false); await vi.advanceTimersByTimeAsync(5000); expect(client.getSystemMetrics).toHaveBeenCalledTimes(4);
  view.setVisible(true); await vi.advanceTimersByTimeAsync(0); expect(client.getSystemMetrics).toHaveBeenCalledTimes(5);
  environment = "prod"; mounts.environmentChanged();
  await vi.advanceTimersByTimeAsync(5000); expect(client.getSystemMetrics).toHaveBeenCalledTimes(5);
  view.dispose(); mounts.destroy(); expect(disconnect).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
