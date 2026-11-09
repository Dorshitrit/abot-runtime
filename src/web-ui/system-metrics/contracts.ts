export type SystemMetricScope = "computer" | "wsl" | "container";

export type SystemMetricsScope = Readonly<{
  kind: SystemMetricScope;
  platform: NodeJS.Platform;
  /** A container can run inside the WSL VM. Its counters still describe the container. */
  withinWsl: boolean;
}>;

export type SystemTemperature = Readonly<{
  celsius: number | null;
  sensor: string | null;
  scope: "computer" | null;
  reason: "unsupported" | "not_exposed" | null;
}>;

export type SystemMetricsSnapshot = Readonly<{
  sampledAt: string;
  scope: SystemMetricsScope;
  cpu: Readonly<{ percent: number | null; capacity: number; reason: "sampling" | "unavailable" | null }>;
  memory: Readonly<{
    usedBytes: number | null;
    totalBytes: number | null;
    percent: number | null;
    basis: "available" | "free" | "cgroup" | "vm_stat";
  }>;
  temperature: SystemTemperature;
}>;

export type CpuObservation = Readonly<{
  identity: string;
  busyMs: number;
  totalMs: number;
  capacity: number;
}>;

export type SystemMetricsObservation = Readonly<{
  scope: SystemMetricsScope;
  cpu: CpuObservation | null;
  memory: SystemMetricsSnapshot["memory"];
}>;
