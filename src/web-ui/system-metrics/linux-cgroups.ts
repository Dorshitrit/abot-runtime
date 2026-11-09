import type { CpuObservation, SystemMetricsSnapshot } from "./contracts.js";
import { cgroupAncestors, type CgroupLocations } from "./linux-cgroup-paths.js";
import { nonnegativeCounter, type ReadSystemText } from "./system-files.js";

export function countCpuSet(value: string | null): number | null {
  if (!value) return null;
  let count = 0;
  let previousEnd = -1;
  for (const part of value.split(",")) {
    if (!/^\d+(?:-\d+)?$/.test(part)) return null;
    const [start, end = start] = part.split("-").map(Number);
    if (start <= previousEnd || end < start || end > 1_000_000) return null;
    count += end - start + 1; previousEnd = end;
  }
  return count > 0 ? count : null;
}

function quotaCapacity(quota: string | null, period: string | null): number | null {
  const limit = nonnegativeCounter(quota); const interval = nonnegativeCounter(period);
  if (!limit || !interval) return null;
  return limit / interval;
}

async function readCpuCapacity(locations: CgroupLocations, read: ReadSystemText, systemCpuCount: number): Promise<number> {
  const quotas = await Promise.all(cgroupAncestors(locations.cpu).map(async path => {
    if (locations.cpu?.version === 2) {
      const [quota, period] = (await read(`${path}/cpu.max`) ?? "").split(/\s+/);
      return quotaCapacity(quota ?? null, period ?? null);
    }
    const [quota, period] = await Promise.all([read(`${path}/cpu.cfs_quota_us`), read(`${path}/cpu.cfs_period_us`)]);
    return quotaCapacity(quota, period);
  }));
  const sets = await Promise.all(cgroupAncestors(locations.cpuset).map(async path => {
    const effective = locations.cpuset?.version === 2 ? "cpuset.cpus.effective" : "cpuset.effective_cpus";
    const value = await read(`${path}/${effective}`) || await read(`${path}/cpuset.cpus`);
    return countCpuSet(value);
  }));
  const limits = [...quotas, ...sets].filter((value): value is number => value !== null && value > 0);
  return Math.min(Math.max(1, systemCpuCount), ...limits);
}

async function readMemory(locations: CgroupLocations, read: ReadSystemText,
  machineTotal: number): Promise<SystemMetricsSnapshot["memory"]> {
  const missing = { usedBytes: null, totalBytes: null, percent: null, basis: "cgroup" as const };
  if (!locations.memory) return missing;
  const usageFile = locations.memory.version === 2 ? "memory.current" : "memory.usage_in_bytes";
  const limitFile = locations.memory.version === 2 ? "memory.max" : "memory.limit_in_bytes";
  const [usage, ...limits] = await Promise.all([
    read(`${locations.memory.directory}/${usageFile}`),
    ...cgroupAncestors(locations.memory).map(path => read(`${path}/${limitFile}`)),
  ]);
  const usedBytes = nonnegativeCounter(usage);
  if (usedBytes === null) return missing;
  const knownLimits = limits.map(nonnegativeCounter).filter((value): value is number => value !== null && value > 0);
  const totalBytes = Math.min(machineTotal, ...knownLimits);
  if (totalBytes <= 0) return missing;
  return { usedBytes, totalBytes, percent: Math.min(100, usedBytes / totalBytes * 100), basis: "cgroup" };
}

export async function readContainerMetrics(locations: CgroupLocations | null, read: ReadSystemText,
  machineTotal: number, systemCpuCount: number, monotonicMs: number): Promise<{
    cpu: CpuObservation | null; memory: SystemMetricsSnapshot["memory"];
  }> {
  const missing = { cpu: null, memory: { usedBytes: null, totalBytes: null, percent: null, basis: "cgroup" as const } };
  if (!locations) return missing;
  const unifiedAccounting = locations.accounting?.version === 2;
  const [capacity, memory, accounting] = await Promise.all([
    readCpuCapacity(locations, read, systemCpuCount), readMemory(locations, read, machineTotal),
    locations.accounting ? read(`${locations.accounting.directory}/${unifiedAccounting ? "cpu.stat" : "cpuacct.usage"}`) : null,
  ]);
  const usage = unifiedAccounting ? accounting?.match(/^usage_usec\s+(\d+)$/m)?.[1] ?? null : accounting;
  const counter = nonnegativeCounter(usage);
  if (counter === null || !locations.accounting) return { cpu: null, memory };
  return { memory, cpu: {
    identity: `${locations.accounting.version}:${locations.accounting.directory}:${capacity}`,
    busyMs: counter / (unifiedAccounting ? 1_000 : 1_000_000),
    totalMs: monotonicMs * capacity, capacity,
  } };
}
