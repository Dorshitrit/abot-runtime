import os from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { createSystemObservationReader } from "./observation.js";
import { createSystemMetricsSampler } from "./sampler.js";

afterEach(() => vi.restoreAllMocks());

function systemCpus(): ReturnType<typeof os.cpus> {
  return Array.from({ length: 8 }, () => ({ model: "CPU", speed: 0,
    times: { user: 20, nice: 0, sys: 30, idle: 50, irq: 0 } }));
}

function containerFiles(): Record<string, string> {
  return {
    "/proc/sys/kernel/osrelease": "6.8.0",
    "/proc/self/cgroup": "0::/",
    "/proc/self/mountinfo": "29 20 0:25 /docker/id /sys/fs/cgroup rw - cgroup2 cgroup rw",
    "/sys/fs/cgroup/cpu.stat": "usage_usec 1000000",
    "/sys/fs/cgroup/cpu.max": "200000 100000",
    "/sys/fs/cgroup/cpuset.cpus.effective": "0-2",
    "/sys/fs/cgroup/memory.current": "256",
    "/sys/fs/cgroup/memory.max": "1024",
  };
}

test.each([
  ["6.8.0", false], ["6.6.0-microsoft-standard-WSL2", true],
] as const)("systemd-only container on %s uses cgroup counters and scope", async (release, withinWsl) => {
  const values: Record<string, string> = { ...containerFiles(),
    "/proc/sys/kernel/osrelease": release, "/run/systemd/container": "docker" };
  const observe = createSystemObservationReader({ platform: "linux", read: async path => values[path] ?? null,
    cpus: systemCpus, totalmem: () => 16_000, freemem: () => 8000, monotonic: () => 1000 });
  const sample = await observe();
  expect(sample.scope).toEqual({ kind: "container", platform: "linux", withinWsl });
  expect(sample.cpu).toMatchObject({ busyMs: 1000, totalMs: 2000, capacity: 2 });
  expect(sample.memory).toEqual({ usedBytes: 256, totalBytes: 1024, percent: 25, basis: "cgroup" });
});

test.each([null, "", " \n"])("an absent or empty systemd marker (%j) does not label a computer as a container", async marker => {
  const observe = createSystemObservationReader({ platform: "linux",
    read: async path => path === "/run/systemd/container" ? marker : null,
    cpus: systemCpus, totalmem: () => 1000, freemem: () => 300 });
  const sample = await observe();
  expect(sample.scope.kind).toBe("computer");
  expect(sample.memory).toMatchObject({ usedBytes: 700, totalBytes: 1000, basis: "free" });
});

test.each([
  ["200000 100000", "0-2", 2],
  ["max 100000", "0-2", 3],
  ["400000 100000", "0-1", 2],
  ["3200000 100000", "0-15", 8],
] as const)("container CPU uses quota %s and cpuset %s despite Runtime affinity=1", async (quota, cpuset, capacity) => {
  vi.spyOn(os, "availableParallelism").mockReturnValue(1);
  const values: Record<string, string> = { ...containerFiles(), "/.dockerenv": "",
    "/sys/fs/cgroup/cpu.max": quota, "/sys/fs/cgroup/cpuset.cpus.effective": cpuset };
  let now = 1000;
  const observe = createSystemObservationReader({ platform: "linux", read: async path => values[path] ?? null,
    cpus: systemCpus, totalmem: () => 16_000, monotonic: () => now });
  const sampler = createSystemMetricsSampler({ observe, now: () => now,
    temperature: async () => ({ celsius: null, sensor: null, scope: null, reason: "not_exposed" }) });
  await sampler.read();
  now = 3000;
  values["/sys/fs/cgroup/cpu.stat"] = "usage_usec 3000000";
  const sample = await sampler.read();
  expect(sample.cpu.capacity).toBe(capacity);
  expect(sample.cpu.percent).toBeCloseTo(100 / capacity);
});
