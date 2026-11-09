import os from "node:os";
import type { CpuObservation, SystemMetricsObservation, SystemMetricsScope } from "./contracts.js";
import { readSystemMetricsScope } from "./environment.js";
import { findCgroupLocations } from "./linux-cgroup-paths.js";
import { readContainerMetrics } from "./linux-cgroups.js";
import { readMacosMemory } from "./macos-memory.js";
import { readSystemText, type ReadSystemText } from "./system-files.js";

function readCpuObservation(cpus: ReturnType<typeof os.cpus>): CpuObservation | null {
  if (!cpus.length) return null;
  let totalMs = 0; let idleMs = 0;
  for (const cpu of cpus) {
    totalMs += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    idleMs += cpu.times.idle;
  }
  return { identity: `os:${cpus.length}`, capacity: cpus.length, busyMs: totalMs - idleMs, totalMs };
}

export function createSystemObservationReader(options: {
  platform?: NodeJS.Platform; read?: ReadSystemText; cpus?: typeof os.cpus;
  totalmem?: typeof os.totalmem; freemem?: typeof os.freemem;
  vmStat?: () => Promise<string>;
  monotonic?: () => number;
} = {}) {
  const platform = options.platform ?? process.platform;
  const read = options.read ?? readSystemText;
  let scope: Promise<SystemMetricsScope> | undefined;
  return async (): Promise<SystemMetricsObservation> => {
    scope ??= readSystemMetricsScope(platform, read);
    const currentScope = await scope;
    const totalBytes = (options.totalmem ?? os.totalmem)();
    const cpus = (options.cpus ?? os.cpus)();
    if (currentScope.kind === "container") {
      const locations = await findCgroupLocations(read);
      // Container counters cover every process, regardless of Runtime's own CPU affinity.
      const values = await readContainerMetrics(locations, read, totalBytes,
        cpus.length, (options.monotonic ?? performance.now.bind(performance))());
      return { scope: currentScope, ...values };
    }
    const cpu = readCpuObservation(cpus);
    if (platform === "darwin") {
      const memory = await readMacosMemory(totalBytes, options.vmStat);
      if (memory) return { scope: currentScope, cpu, memory };
    }
    const meminfo = platform === "linux" ? await read("/proc/meminfo") : null;
    const availableKb = meminfo?.match(/^MemAvailable:\s+(\d+)\s+kB$/m)?.[1];
    const basis = availableKb ? "available" : "free";
    const free = availableKb ? Number(availableKb) * 1024 : (options.freemem ?? os.freemem)();
    const usedBytes = Math.max(0, Math.min(totalBytes, totalBytes - free));
    return { scope: currentScope, cpu, memory: {
      usedBytes, totalBytes, percent: totalBytes > 0 ? usedBytes / totalBytes * 100 : null, basis,
    } };
  };
}
