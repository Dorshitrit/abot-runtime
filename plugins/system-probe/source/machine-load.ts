import os from "node:os";

type MachineLoad = Readonly<{
  loadAverage: readonly number[] | null;
  loadLevel: "low" | "moderate" | "high" | "unsupported";
}>;

function supportsLoadAverage(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

function classifyLoadPerCpu(loadAverage: readonly number[], cpuCount: number) {
  const average = loadAverage[0] ?? 0;
  const loadPerCpu = cpuCount > 0 ? average / cpuCount : average;
  if (loadPerCpu < 0.5) return "low";
  if (loadPerCpu < 1) return "moderate";
  return "high";
}

export function readMachineLoad(
  platform: NodeJS.Platform,
  cpuCount: number,
  readLoadAverage: () => number[] = () => os.loadavg(),
): MachineLoad {
  if (!supportsLoadAverage(platform)) {
    return Object.freeze({ loadAverage: null, loadLevel: "unsupported" });
  }
  const loadAverage = Object.freeze(readLoadAverage());
  return Object.freeze({
    loadAverage,
    loadLevel: classifyLoadPerCpu(loadAverage, cpuCount),
  });
}
