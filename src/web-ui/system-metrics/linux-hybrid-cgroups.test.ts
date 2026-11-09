import { expect, test } from "vitest";
import { findCgroupLocations } from "./linux-cgroup-paths.js";
import { readContainerMetrics } from "./linux-cgroups.js";

function hybridFiles(legacyControllers: string[]): Record<string, string> {
  const mounts = ["29 20 0:25 / /sys/fs/cgroup/unified rw - cgroup2 cgroup rw"];
  const memberships = ["0::/work"];
  const values: Record<string, string> = {
    // v2 accounting exists even when its CPU controller is not enabled.
    "/sys/fs/cgroup/unified/work/cpu.stat": "usage_usec 500000",
  };
  const controllers = [
    { name: "cpu", v1: { "cpu.cfs_quota_us": "150000", "cpu.cfs_period_us": "100000" },
      v2: { "cpu.max": "400000 100000" } },
    { name: "cpuacct", v1: { "cpuacct.usage": "2500000000" }, v2: {} },
    { name: "memory", v1: { "memory.usage_in_bytes": "250", "memory.limit_in_bytes": "500" },
      v2: { "memory.current": "150", "memory.max": "600" } },
    { name: "cpuset", v1: { "cpuset.effective_cpus": "1-2" }, v2: { "cpuset.cpus.effective": "0-2" } },
  ];
  for (const [index, controller] of controllers.entries()) {
    const legacy = legacyControllers.includes(controller.name);
    const mount = legacy ? `/sys/fs/cgroup/${controller.name}` : "/sys/fs/cgroup/unified";
    if (legacy) {
      memberships.push(`${index + 2}:${controller.name}:/work`);
      mounts.push(`${index + 30} 20 0:${index + 26} / ${mount} rw - cgroup cgroup rw,${controller.name}`);
    }
    for (const [name, value] of Object.entries(legacy ? controller.v1 : controller.v2)) {
      values[`${mount}/work/${name}`] = value;
    }
  }
  return { ...values, "/proc/self/cgroup": memberships.join("\n"), "/proc/self/mountinfo": mounts.join("\n") };
}

test.each([
  { name: "all controllers on v1", legacy: ["cpu", "cpuacct", "memory", "cpuset"], capacity: 1.5,
    busyMs: 2500, usedBytes: 250, totalBytes: 500 },
  { name: "v1 CPU and cpuset with v2 memory", legacy: ["cpu", "cpuacct", "cpuset"], capacity: 1.5,
    busyMs: 2500, usedBytes: 150, totalBytes: 600 },
  { name: "v2 CPU with v1 cpuset and memory", legacy: ["memory", "cpuset"], capacity: 2,
    busyMs: 500, usedBytes: 250, totalBytes: 500 },
  { name: "v1 CPU limits with v2 accounting", legacy: ["cpu"], capacity: 1.5,
    busyMs: 500, usedBytes: 150, totalBytes: 600 },
  { name: "v2 CPU limits with v1 accounting", legacy: ["cpuacct", "memory"], capacity: 3,
    busyMs: 2500, usedBytes: 250, totalBytes: 500 },
])("hybrid cgroups resolve $name", async ({ legacy, capacity, busyMs, usedBytes, totalBytes }) => {
  const values = hybridFiles(legacy);
  const read = async (path: string) => values[path] ?? null;
  const sample = await readContainerMetrics(await findCgroupLocations(read), read, 16_000, 8, 2000);
  expect(sample.cpu).toMatchObject({ busyMs, capacity, totalMs: 2000 * capacity });
  expect(sample.memory).toEqual({ usedBytes, totalBytes, percent: usedBytes / totalBytes * 100, basis: "cgroup" });
});

test("a bound but unmounted v1 controller does not silently read another hierarchy", async () => {
  const values = hybridFiles(["cpu", "cpuacct", "memory", "cpuset"]);
  values["/proc/self/mountinfo"] = values["/proc/self/mountinfo"].split("\n")
    .filter(line => !/rw,(?:cpuacct|memory)$/.test(line)).join("\n");
  const read = async (path: string) => values[path] ?? null;
  const sample = await readContainerMetrics(await findCgroupLocations(read), read, 16_000, 8, 2000);
  expect(sample.cpu).toBeNull();
  expect(sample.memory).toMatchObject({ usedBytes: null, totalBytes: null, percent: null });
});
