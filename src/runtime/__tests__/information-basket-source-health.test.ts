import { setImmediate } from "node:timers/promises";
import { getEventListeners } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { BASKET_LIMITS } from "../information-basket/limits.js";
import { createBasketSourceHealth } from "../information-basket/source-health.js";
import { createBasketSourceHealthMonitor } from "../information-basket/source-health-monitor.js";
import { healthState } from "./support/information-basket-health-fixture.js";
import { createBasketMetadataPool } from "../information-basket/source-health-pool.js";

afterEach(() => vi.useRealTimers());
const signal = () => new AbortController().signal;

test("repeated cancelled consumers leave no subscriptions or extra physical reads on blocked IO", async () => {
  const readIdentity = vi.fn(() => new Promise<string>(() => {}));
  const pool = createBasketMetadataPool(readIdentity);
  const holders = Array.from({ length: 4 }, () => new AbortController());
  const pending = holders.map((controller, index) => pool.read(`binding-${index}`, `/held-${index}`, controller.signal).catch(error => error));
  await setImmediate();
  for (let index = 0; index < 100; index++) {
    const controller = new AbortController();
    const request = pool.read(index % 2 ? "binding-0" : "new-binding", "/waiting", controller.signal).catch(error => error);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    controller.abort();
    await request;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  }
  for (const controller of holders) controller.abort();
  await Promise.all(pending);
  expect(readIdentity).toHaveBeenCalledTimes(4);
});

test("1,000 source checks yield to the loop, cap physical IO at four, and batch invalidation", async () => {
  const f = await healthState(1_000);
  let active = 0;
  let peak = 0;
  let loopTurns = 0;
  const heartbeat = setInterval(() => loopTurns++, 0);
  const readIdentity = vi.fn(async () => {
    peak = Math.max(peak, ++active);
    await setImmediate();
    active--;
    return "changed";
  });
  const health = createBasketSourceHealth({ state: f.state, readIdentity });
  try { await health.validate(f.sources, signal()); }
  finally { clearInterval(heartbeat); }
  expect(readIdentity).toHaveBeenCalledTimes(1_000);
  expect(peak).toBe(BASKET_LIMITS.healthConcurrency);
  expect(loopTurns).toBeGreaterThan(0);
  expect(active).toBe(0);
  expect(f.update).toHaveBeenCalledOnce();
  expect(f.state.snapshot()!.sources.every(source => source.status === "stale" && !source.index)).toBe(true);
  readIdentity.mockClear();
  await health.validate(f.state.snapshot()!.sources, signal());
  expect(readIdentity).not.toHaveBeenCalled();
});

test("parallel consumers share in-flight checks and one cancellation cannot cancel another", async () => {
  const f = await healthState(4);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const readIdentity = vi.fn(async () => { await blocked; return f.sources[0]!.index!.fileIdentity; });
  const health = createBasketSourceHealth({ state: f.state, readIdentity });
  const first = new AbortController();
  const a = health.validate(f.sources, first.signal).catch(error => error);
  const b = health.validate(f.sources, signal());
  await setImmediate();
  expect(readIdentity).toHaveBeenCalledTimes(4);
  first.abort(new Error("caller finished"));
  expect(await a).toMatchObject({ message: "caller finished" });
  release();
  await b;
  expect(f.update).not.toHaveBeenCalled();
  // No success cache: a later exposure must inspect the originals again.
  await health.validate(f.sources, signal());
  expect(readIdentity).toHaveBeenCalledTimes(8);
});

test("cancelled physical checks retain their slots and cannot publish a late invalidation", async () => {
  const f = await healthState(100);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const readIdentity = vi.fn(async () => { await blocked; return "changed"; });
  const health = createBasketSourceHealth({ state: f.state, readIdentity });
  const controller = new AbortController();
  const pending = health.validate(f.sources, controller.signal).catch(error => error);
  await setImmediate();
  controller.abort();
  await pending;
  const next = new AbortController();
  const waiting = health.validate(f.sources.slice(4), next.signal).catch(error => error);
  await setImmediate();
  expect(readIdentity).toHaveBeenCalledTimes(4);
  next.abort();
  await waiting;
  release();
  await setImmediate();
  expect(f.update).not.toHaveBeenCalled();
  expect(f.state.snapshot()!.sources.every(source => source.status === "ready")).toBe(true);
});

test.each(["reindex", "remove"] as const)("a late failed check cannot invalidate a concurrent %s", async action => {
  const f = await healthState();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const health = createBasketSourceHealth({ state: f.state, readIdentity: async () => { await blocked; return "changed"; } });
  const pending = health.validate(f.sources, signal());
  await setImmediate();
  await f.state.update(current => ({ ...current, sources: action === "remove" ? []
    : current.sources.map(source => ({ ...source, revision: 2 })) }));
  release();
  await pending;
  expect(f.state.snapshot()!.sources).toEqual(action === "remove" ? [] : [{ ...f.sources[0], revision: 2 }]);
});

test("a reindexed revision cannot reuse an older revision's in-flight filesystem observation", async () => {
  const f = await healthState();
  let release!: (identity: string) => void;
  const readIdentity = vi.fn(async () => "new-identity").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const health = createBasketSourceHealth({ state: f.state, readIdentity });
  const oldCheck = health.validate(f.sources, signal());
  await setImmediate();
  await f.state.update(current => ({ ...current, sources: current.sources.map(source => ({ ...source,
    revision: 2, index: { ...source.index!, fileIdentity: "new-identity" },
  })) }));
  const freshCheck = health.validate(f.state.snapshot()!.sources, signal());
  await setImmediate();
  expect(readIdentity).toHaveBeenCalledTimes(2);
  release("old-identity");
  await Promise.all([oldCheck, freshCheck]);
  expect(f.state.snapshot()!.sources[0]).toMatchObject({ revision: 2, status: "ready" });
});

test("the environment sweep is periodic, singleton, stops, and does no disabled IO", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = await healthState();
  const readIdentity = vi.fn(async () => f.sources[0]!.index!.fileIdentity);
  const monitor = createBasketSourceHealthMonitor(f.state, createBasketSourceHealth({ state: f.state, readIdentity }));
  try {
    monitor.start();
    monitor.start();
    await setImmediate();
    await setImmediate();
    expect(readIdentity).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(BASKET_LIMITS.healthIntervalMs - 1);
    expect(readIdentity).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await setImmediate();
    expect(readIdentity).toHaveBeenCalledTimes(2);
    await f.state.update(current => ({ ...current, settings: { ...current.settings, enabled: false, revision: 2 } }));
    await vi.advanceTimersByTimeAsync(BASKET_LIMITS.healthIntervalMs * 5);
    expect(readIdentity).toHaveBeenCalledTimes(2);
  } finally { await monitor.stop(); }
  await vi.advanceTimersByTimeAsync(BASKET_LIMITS.healthIntervalMs * 5);
  expect(readIdentity).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
