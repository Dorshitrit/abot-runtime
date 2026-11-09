import { expect, test } from "vitest";
import { findCgroupLocations } from "./linux-cgroup-paths.js";
import { countCpuSet, readContainerMetrics } from "./linux-cgroups.js";

function files(values: Record<string, string>) { return async (path: string) => values[path] ?? null; }
const v2Mount = "29 20 0:25 / /sys/fs/cgroup rw - cgroup2 cgroup rw";

test("cgroup v2 measures the container, with inherited memory/quota and effective cpuset limits", async () => {
  const read = files({
    "/proc/self/cgroup": "0::/parent/work", "/proc/self/mountinfo": v2Mount,
    "/sys/fs/cgroup/parent/work/cpu.stat": "usage_usec 500000\nuser_usec 300000",
    "/sys/fs/cgroup/parent/work/cpu.max": "max 100000",
    "/sys/fs/cgroup/parent/cpu.max": "50000 100000",
    "/sys/fs/cgroup/parent/work/cpuset.cpus.effective": "0-3,6",
    "/sys/fs/cgroup/parent/work/memory.current": "200",
    "/sys/fs/cgroup/parent/work/memory.max": "max",
    "/sys/fs/cgroup/parent/memory.max": "400",
  });
  const result = await readContainerMetrics(await findCgroupLocations(read), read, 16_000, 8, 1000);
  expect(result.cpu).toMatchObject({ busyMs: 500, totalMs: 500, capacity: 0.5 });
  expect(result.memory).toEqual({ usedBytes: 200, totalBytes: 400, percent: 50, basis: "cgroup" });
});

test("private cgroup namespaces bind / to the exposed mount root without escaping to host files", async () => {
  const read = files({
    "/proc/self/cgroup": "0::/",
    "/proc/self/mountinfo": "29 20 0:25 /docker/container-id /sys/fs/cgroup rw - cgroup2 cgroup rw",
    "/sys/fs/cgroup/cpu.stat": "usage_usec 2000000", "/sys/fs/cgroup/cpu.max": "max 100000",
    "/sys/fs/cgroup/cpuset.cpus.effective": "2-3", "/sys/fs/cgroup/memory.current": "50",
    "/sys/fs/cgroup/memory.max": "max",
  });
  const locations = await findCgroupLocations(read);
  expect(locations?.cpu?.directory).toBe("/sys/fs/cgroup");
  const sample = await readContainerMetrics(locations, read, 1000, 8, 1000);
  expect(sample.cpu).toMatchObject({ busyMs: 2000, totalMs: 2000, capacity: 2 });
  expect(sample.memory.totalBytes).toBe(1000);
});

test("cgroup v1 supports separately mounted CPU, accounting, cpuset and memory controllers", async () => {
  const read = files({
    "/proc/self/cgroup": "2:cpu,cpuacct:/docker/id\n3:memory:/docker/id\n4:cpuset:/docker/id",
    "/proc/self/mountinfo": [
      "29 20 0:25 / /sys/fs/cgroup/cpu,cpuacct rw - cgroup cgroup rw,cpu,cpuacct",
      "30 20 0:26 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory",
      "31 20 0:27 / /sys/fs/cgroup/cpuset rw - cgroup cgroup rw,cpuset",
    ].join("\n"),
    "/sys/fs/cgroup/cpu,cpuacct/docker/id/cpuacct.usage": "2500000000",
    "/sys/fs/cgroup/cpu,cpuacct/docker/id/cpu.cfs_quota_us": "150000",
    "/sys/fs/cgroup/cpu,cpuacct/docker/id/cpu.cfs_period_us": "100000",
    "/sys/fs/cgroup/cpuset/docker/id/cpuset.cpus": "0-3",
    "/sys/fs/cgroup/memory/docker/id/memory.usage_in_bytes": "250",
    "/sys/fs/cgroup/memory/docker/id/memory.limit_in_bytes": "500",
  });
  const sample = await readContainerMetrics(await findCgroupLocations(read), read, 16_000, 8, 2000);
  expect(sample.cpu).toMatchObject({ busyMs: 2500, totalMs: 3000, capacity: 1.5 });
  expect(sample.memory).toMatchObject({ usedBytes: 250, totalBytes: 500, percent: 50 });
});

test("hidden or inaccessible container counters never become host usage", async () => {
  const read = files({ "/proc/self/cgroup": "0::/", "/proc/self/mountinfo": v2Mount });
  const sample = await readContainerMetrics(await findCgroupLocations(read), read, 1000, 8, 10);
  expect(sample.cpu).toBeNull();
  expect(sample.memory).toMatchObject({ usedBytes: null, totalBytes: null, percent: null });
  expect(await findCgroupLocations(files({}))).toBeNull();
});

test("v1 unlimited sentinel is bounded by machine capacity; malformed counters stay unavailable", async () => {
  const location = { version: 1 as const, directory: "/sys/fs/cgroup", mount: "/sys/fs/cgroup" };
  const locations = { cpu: location, accounting: location, memory: location, cpuset: location };
  const read = files({ "/sys/fs/cgroup/memory.usage_in_bytes": "90", "/sys/fs/cgroup/memory.limit_in_bytes": "9223372036854771712",
    "/sys/fs/cgroup/cpuacct.usage": "broken", "/sys/fs/cgroup/cpu.cfs_quota_us": "-1" });
  const sample = await readContainerMetrics(locations, read, 100, 4, 10);
  expect(sample.cpu).toBeNull(); expect(sample.memory.percent).toBe(90);
});

test("mount mappings reject membership outside the exposed hierarchy", async () => {
  const read = files({ "/proc/self/cgroup": "0::/outside/escape",
    "/proc/self/mountinfo": "29 20 0:25 /restricted /sys/fs/cgroup rw - cgroup2 cgroup rw" });
  expect(await findCgroupLocations(read)).toBeNull();
});

test.each([["0-3,6,8-9", 7], ["0", 1], ["", null], ["0-2,1", null], ["3-1", null], ["x", null]])(
  "CPU set %s has capacity %s", (value, count) => expect(countCpuSet(value as string)).toBe(count),
);
