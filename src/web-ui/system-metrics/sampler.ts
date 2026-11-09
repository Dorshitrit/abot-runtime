import type { CpuObservation, SystemMetricsObservation, SystemMetricsScope, SystemMetricsSnapshot, SystemTemperature } from "./contracts.js";
import { createSystemObservationReader } from "./observation.js";
import { createTemperatureReader } from "./temperature.js";

function sampledCpu(previous: CpuObservation | null, current: CpuObservation | null): SystemMetricsSnapshot["cpu"] {
  if (!current) return { percent: null, capacity: 0, reason: "unavailable" };
  const sampling = { percent: null, capacity: current.capacity, reason: "sampling" as const };
  if (!previous || previous.identity !== current.identity) return sampling;
  const total = current.totalMs - previous.totalMs;
  const busy = current.busyMs - previous.busyMs;
  if (total <= 0 || busy < 0) return sampling;
  return { percent: Math.min(100, Math.max(0, busy / total * 100)), capacity: current.capacity, reason: null };
}

/** Shared by HTTP readers. No timer, event emission, history persistence or model call. */
export function createSystemMetricsSampler(options: {
  observe?: () => Promise<SystemMetricsObservation>;
  temperature?: (scope: SystemMetricsScope) => Promise<SystemTemperature>;
  now?: () => number; timestamp?: () => string;
} = {}) {
  const observe = options.observe ?? createSystemObservationReader();
  const temperature = options.temperature ?? createTemperatureReader();
  const now = options.now ?? performance.now.bind(performance);
  const timestamp = options.timestamp ?? (() => new Date().toISOString());
  let previous: CpuObservation | null = null;
  let previousAt = -Infinity;
  let cached: SystemMetricsSnapshot | undefined;
  let cachedAt = -Infinity;
  let pending: Promise<SystemMetricsSnapshot> | undefined;
  async function sample(): Promise<SystemMetricsSnapshot> {
    const observation = await observe();
    const at = now();
    const cpu = sampledCpu(at - previousAt <= 15_000 ? previous : null, observation.cpu);
    previous = observation.cpu; previousAt = at;
    const sampledAt = timestamp();
    const thermal = await temperature(observation.scope);
    cached = { sampledAt, scope: observation.scope, cpu, memory: observation.memory, temperature: thermal };
    cachedAt = at;
    return cached;
  }
  return {
    async read(): Promise<SystemMetricsSnapshot> {
      if (pending) return pending;
      if (cached && now() - cachedAt < 1000) return cached;
      pending = sample();
      try { return await pending; } finally { pending = undefined; }
    },
  };
}
