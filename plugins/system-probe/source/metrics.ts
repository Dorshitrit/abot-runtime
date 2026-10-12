import os from "node:os";

import { readMachineLoad } from "./machine-load.js";

export function bytesToGiB(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

export function readMachineMetrics() {
  const memoryTotalBytes = os.totalmem();
  const memoryFreeBytes = os.freemem();
  const cpuCount = os.cpus().length;
  const platform = os.platform();
  const load = readMachineLoad(platform, cpuCount);
  return Object.freeze({
    platform,
    architecture: os.arch(),
    uptimeSeconds: os.uptime(),
    cpuCount,
    ...load,
    memoryTotalBytes,
    memoryFreeBytes,
    memoryUsedBytes: Math.max(0, memoryTotalBytes - memoryFreeBytes),
  });
}
