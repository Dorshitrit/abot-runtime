import { execFile } from "node:child_process";
import type { SystemMetricsSnapshot } from "./contracts.js";

/** Anonymous app pages + wired + physical compressor pages, excluding purgeable cache. */
export function parseMacosMemory(output: string, totalBytes: number): SystemMetricsSnapshot["memory"] | null {
  const pageSize = Number(output.match(/page size of (\d+) bytes/)?.[1]);
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || totalBytes <= 0) return null;
  const counts = new Map<string, number>();
  for (const line of output.split("\n")) {
    const match = line.match(/^([A-Za-z -]+):\s+(\d+)\.?\s*$/);
    if (match) counts.set(match[1], Number(match[2]));
  }
  const pages = ["Anonymous pages", "Pages wired down", "Pages occupied by compressor", "Pages purgeable"]
    .map(name => counts.get(name));
  if (pages.some(value => value === undefined || !Number.isSafeInteger(value))) return null;
  const [anonymous, wired, compressed, purgeable] = pages as number[];
  const usedBytes = (anonymous + wired + compressed - purgeable) * pageSize;
  if (!Number.isSafeInteger(usedBytes) || usedBytes < 0 || usedBytes > totalBytes) return null;
  return { usedBytes, totalBytes, percent: usedBytes / totalBytes * 100, basis: "vm_stat" };
}

function readVmStatistics(): Promise<string> {
  return new Promise(resolve => {
    execFile("/usr/bin/vm_stat", [], {
      encoding: "utf8", timeout: 500, maxBuffer: 8192, env: { ...process.env, LC_ALL: "C" },
    }, (error, stdout) => resolve(error ? "" : stdout));
  });
}

/** One bounded, shell-free system command per shared on-demand observation; no helper installation. */
export async function readMacosMemory(totalBytes: number, statistics = readVmStatistics) {
  try { return parseMacosMemory(await statistics(), totalBytes); }
  catch { return null; }
}
