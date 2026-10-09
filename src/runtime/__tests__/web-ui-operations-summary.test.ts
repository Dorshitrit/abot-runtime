import { afterEach, expect, test, vi } from "vitest";
import { createOperationsController } from "../../web-ui/app/controllers/operations-controller.js";

type Payload = Record<string, unknown>;
type Tab = "runtime" | "logs" | "health";

function deferred() {
  let resolve!: (value: Payload) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Payload>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  let environment = "dev";
  const dom = {
    runtimeStatus: { innerHTML: "", textContent: "" },
    runtimeLogs: { textContent: "" },
    healthStatus: { innerHTML: "", textContent: "" },
  };
  const client = {
    getRuntimeStatus: vi.fn<() => Promise<Payload>>(async () => ({
      source: "local-runtime", status: { pid: 42, uptimeMs: 65_000, node: { version: "v24" } },
    })),
    getRuntimeLogs: vi.fn<() => Promise<Payload>>(async () => ({ log: { lines: ["first", "second"], exists: true } })),
    getSystemHealth: vi.fn<() => Promise<Payload>>(async () => ({
      ok: true, agentMode: "reasoning", activeStreamingRequests: 2,
      activeStreamingRequestDetails: [
        { lastEventAt: 100, lastEventName: "older" },
        { lastEventAt: 200, lastEventType: "newer" },
      ],
    })),
  };
  const onSummaryChange = vi.fn();
  const controller = createOperationsController({ dom, client, getEnvironmentId: () => environment, onSummaryChange });
  const requests = { runtime: client.getRuntimeStatus, logs: client.getRuntimeLogs, health: client.getSystemHealth };
  const load = { runtime: controller.loadRuntimeStatus, logs: controller.loadRuntimeLogs, health: controller.loadSystemHealth };
  const values = (tab: Tab) => controller.summary(tab).items.map((item) => item.value);
  return { dom, client, controller, requests, load, values, onSummaryChange, select: (value: string) => { environment = value; } };
}

afterEach(() => vi.restoreAllMocks());

test("unloaded summaries identify their scope and getters make no requests", () => {
  const h = harness();
  expect(h.values("runtime")).toEqual(["dev", "Not loaded", "Not loaded", "Not loaded"]);
  expect(h.values("logs")).toEqual(["dev", "Not loaded", "Not loaded", "Not loaded"]);
  expect(h.values("health")).toEqual(Array(4).fill("Not loaded"));
  expect(h.controller.summary("health").label).toBe("System health · all environments");
  expect(h.controller.summary("health").items[0]?.label).toBe("Health · all environments");
  expect(h.controller.summary("unknown")).toEqual(h.controller.summary("runtime"));
  for (const request of Object.values(h.requests)) expect(request).not.toHaveBeenCalled();
  expect(h.onSummaryChange).not.toHaveBeenCalled();
});

test("existing reads expose loading then contextual metrics without another fetch", async () => {
  const h = harness();
  const pending = Object.values(h.load).map((load) => load());
  expect(h.values("runtime")).toEqual(["dev", "Loading…", "Loading…", "Loading…"]);
  expect(h.values("logs")).toEqual(["dev", "Loading…", "Loading…", "Loading…"]);
  expect(h.values("health")).toEqual(Array(4).fill("Loading…"));
  await Promise.all(pending);
  expect(h.values("runtime")).toEqual(["dev · local-runtime", "1m", "42", "v24"]);
  expect(h.values("logs")).toEqual(["dev", "2", expect.any(String), "Available"]);
  expect(h.values("health")).toEqual(["Healthy", "reasoning", "2", "newer"]);
  expect(h.onSummaryChange).toHaveBeenCalledTimes(6);
  expect(h.client.getRuntimeStatus).toHaveBeenCalledExactlyOnceWith("dev");
  expect(h.client.getRuntimeLogs).toHaveBeenCalledExactlyOnceWith(100, "dev");
  expect(h.client.getSystemHealth).toHaveBeenCalledExactlyOnceWith();
});

test("missing successful payload fields remain unknown rather than healthy or zero", async () => {
  const h = harness();
  for (const request of Object.values(h.requests)) request.mockResolvedValueOnce({});
  await Promise.all(Object.values(h.load).map((load) => load()));
  expect(h.values("runtime")).toEqual(["dev", "-", "-", "-"]);
  expect(h.values("logs")).toEqual(["dev", "-", expect.any(String), "-"]);
  expect(h.values("health")).toEqual(["-", "-", "-", "-"]);
});

test("known zero values and a missing log file remain distinct from unavailable reads", async () => {
  const h = harness();
  h.client.getRuntimeStatus.mockResolvedValueOnce({ status: { uptimeMs: 0 } });
  h.client.getRuntimeLogs.mockResolvedValueOnce({ log: { lines: [], exists: false } });
  h.client.getSystemHealth.mockResolvedValueOnce({ ok: false, activeStreamingRequestDetails: [] });
  await Promise.all(Object.values(h.load).map((load) => load()));
  expect(h.values("runtime")[1]).toBe("0s");
  expect(h.values("logs")).toEqual(["dev", "0", expect.any(String), "Missing"]);
  expect(h.values("health")).toEqual(["Unhealthy", "-", "0", "-"]);
});

test("failed reads clear previously loaded metrics and expose unavailable state", async () => {
  const h = harness();
  await Promise.all(Object.values(h.load).map((load) => load()));
  h.onSummaryChange.mockClear();
  for (const request of Object.values(h.requests)) request.mockRejectedValueOnce(new Error("unavailable"));
  await Promise.all(Object.values(h.load).map((load) => load()));
  expect(h.values("runtime")).toEqual(["dev", "Unavailable", "Unavailable", "Unavailable"]);
  expect(h.values("logs")).toEqual(["dev", "Unavailable", "Unavailable", "Unavailable"]);
  expect(h.values("health")).toEqual(Array(4).fill("Unavailable"));
  expect(h.onSummaryChange).toHaveBeenCalledTimes(6);
});

test.each(["runtime", "logs"] as const)("%s getter rejects another environment before any refresh", async (tab) => {
  const h = harness();
  await h.load[tab]();
  h.select("prod");
  expect(h.values(tab)).toEqual(["prod", "Not loaded", "Not loaded", "Not loaded"]);
  expect(h.requests[tab]).toHaveBeenCalledOnce();
});

test.each([
  ["runtime", false], ["runtime", true], ["logs", false], ["logs", true],
] as const)("late %s completion cannot publish to a new environment (error=%s)", async (tab, fails) => {
  const h = harness();
  const stale = deferred();
  h.requests[tab].mockReturnValueOnce(stale.promise);
  const pending = h.load[tab]();
  h.select("prod");
  await h.load[tab]();
  const current = h.controller.summary(tab);
  h.onSummaryChange.mockClear();
  if (fails) stale.reject(new Error("old environment"));
  else stale.resolve({ status: { pid: 9 }, log: { lines: ["old"] } });
  await pending;
  expect(h.controller.summary(tab)).toEqual(current);
  expect(h.onSummaryChange).not.toHaveBeenCalled();
});

test.each([
  ["runtime", false], ["runtime", true], ["logs", false], ["logs", true], ["health", false], ["health", true],
] as const)("overlapping %s reads keep the latest completion (error=%s)", async (tab, fails) => {
  const h = harness();
  const stale = deferred();
  h.requests[tab].mockReturnValueOnce(stale.promise);
  const pending = h.load[tab]();
  await h.load[tab]();
  const current = h.controller.summary(tab);
  const currentHealthMarkup = h.dom.healthStatus.innerHTML;
  h.onSummaryChange.mockClear();
  if (fails) stale.reject(new Error("old refresh"));
  else stale.resolve({});
  await pending;
  expect(h.controller.summary(tab)).toEqual(current);
  expect(h.dom.healthStatus.innerHTML).toBe(currentHealthMarkup);
  expect(h.onSummaryChange).not.toHaveBeenCalled();
});

test("environment changes refresh local metrics once while keeping global health", async () => {
  const h = harness();
  await Promise.all(Object.values(h.load).map((load) => load()));
  const health = h.controller.summary("health");
  const observedLogs: string[][] = [];
  h.onSummaryChange.mockImplementation(() => { observedLogs.push(h.values("logs")); });
  h.select("prod");
  h.controller.environmentChanged();
  h.controller.environmentChanged();
  await Promise.resolve();
  expect(observedLogs[0]).toEqual(["prod", "Not loaded", "Not loaded", "Not loaded"]);
  expect(h.controller.summary("health")).toEqual(health);
  expect(h.client.getRuntimeStatus).toHaveBeenCalledTimes(2);
  expect(h.client.getRuntimeLogs).toHaveBeenCalledTimes(2);
  expect(h.client.getSystemHealth).toHaveBeenCalledOnce();
});

test("log refresh time is captured on successful completion and stays stable while reading summaries", async () => {
  const h = harness();
  const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
  await h.load.logs();
  const refreshed = h.values("logs")[2];
  now.mockReturnValue(200_000);
  expect(refreshed).not.toBe("-");
  expect(h.values("logs")[2]).toBe(refreshed);
  expect(h.client.getRuntimeLogs).toHaveBeenCalledOnce();
});
