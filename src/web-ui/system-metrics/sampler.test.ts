import { expect, test, vi } from "vitest";
import { createSystemMetricsSampler } from "./sampler.js";
import { createSystemObservationReader } from "./observation.js";
import { readSystemMetricsScope } from "./environment.js";
import type { SystemMetricsObservation } from "./contracts.js";

const observation: SystemMetricsObservation = {
  scope: { kind: "computer", platform: "darwin", withinWsl: false },
  cpu: { identity: "native", busyMs: 100, totalMs: 1000, capacity: 8 },
  memory: { usedBytes: 400, totalBytes: 1000, percent: 40, basis: "free" },
};
const temperature = async () => ({ celsius: null, sensor: null, scope: null, reason: "unsupported" as const });

test("samples CPU deltas, coalesces readers, caches bursts and resets after a long absence", async () => {
  let now = 0; let source = observation;
  const observe = vi.fn(async () => source);
  const sampler = createSystemMetricsSampler({ observe, temperature, now: () => now, timestamp: () => "now" });
  const first = await Promise.all([sampler.read(), sampler.read(), sampler.read()]);
  expect(observe).toHaveBeenCalledOnce(); expect(first[0]).toBe(first[2]);
  expect(first[0].cpu).toMatchObject({ percent: null, reason: "sampling" });
  now = 500; expect(await sampler.read()).toBe(first[0]);
  now = 2000; source = { ...observation, cpu: { ...observation.cpu!, busyMs: 600, totalMs: 3000 } };
  expect((await sampler.read()).cpu.percent).toBe(25);
  now = 30_000; expect((await sampler.read()).cpu.reason).toBe("sampling");
  expect(observe).toHaveBeenCalledTimes(3);
});

test("counter reset and changed CPU allocation cannot produce fabricated utilization", async () => {
  let now = 0; let source = observation;
  const sampler = createSystemMetricsSampler({ observe: async () => source, temperature, now: () => now });
  await sampler.read(); now = 2000;
  source = { ...source, cpu: { ...source.cpu!, busyMs: 10, totalMs: 500 } };
  expect((await sampler.read()).cpu.percent).toBeNull();
  now = 4000; source = { ...source, cpu: { ...source.cpu!, identity: "different", busyMs: 30, totalMs: 600 } };
  expect((await sampler.read()).cpu.percent).toBeNull();
  now = 6000; source = { ...source, cpu: null };
  expect((await sampler.read()).cpu.reason).toBe("unavailable");
});

test.each(["win32", "darwin", "linux"] as const)("native %s CPU and RAM need only built-in OS interfaces", async platform => {
  const read = vi.fn(async () => null);
  const observe = createSystemObservationReader({ platform, read, totalmem: () => 1000, freemem: () => 300,
    vmStat: async () => "",
    cpus: () => [{ model: "CPU", speed: 0, times: { user: 20, nice: 0, sys: 30, idle: 50, irq: 0 } }] });
  const sample = await observe();
  expect(sample.scope).toMatchObject({ kind: "computer", platform });
  expect(sample.cpu).toMatchObject({ busyMs: 50, totalMs: 100, capacity: 1 });
  expect(sample.memory).toEqual({ usedBytes: 700, totalBytes: 1000, percent: 70, basis: "free" });
  if (platform !== "linux") expect(read).not.toHaveBeenCalled();
});

test("Linux available memory excludes reclaimable caches and WSL never claims Windows host measurements", async () => {
  const values: Record<string, string> = { "/proc/sys/kernel/osrelease": "6.6.0-microsoft-standard-WSL2",
    "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 400 kB" };
  const sample = await createSystemObservationReader({ platform: "linux", read: async path => values[path] ?? null,
    totalmem: () => 1024_000, freemem: () => 1, cpus: () => [] })();
  expect(sample.scope).toEqual({ kind: "wsl", platform: "linux", withinWsl: true });
  expect(sample.memory).toMatchObject({ usedBytes: 614_400, percent: 60, basis: "available" });
});

test("Docker nested in WSL remains a container; inaccessible cgroups are not replaced with VM RAM", async () => {
  const read = async (path: string) => ({ "/.dockerenv": "", "/proc/sys/kernel/osrelease": "microsoft-WSL2" }[path] ?? null);
  const scope = await readSystemMetricsScope("linux", read);
  expect(scope).toEqual({ kind: "container", platform: "linux", withinWsl: true });
  const sample = await createSystemObservationReader({ platform: "linux", read, totalmem: () => 1000,
    freemem: () => 300, cpus: vi.fn(() => []) })();
  expect(sample.memory.usedBytes).toBeNull(); expect(sample.cpu).toBeNull();
});
