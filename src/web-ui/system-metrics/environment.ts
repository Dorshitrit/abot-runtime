import type { SystemMetricsScope } from "./contracts.js";
import { readSystemText, type ReadSystemText } from "./system-files.js";

function isContainerEnvironment(cgroup: string | null, docker: string | null,
  podman: string | null, systemd: string | null): boolean {
  if (docker !== null) return true;
  if (podman !== null) return true;
  if (systemd?.trim()) return true;
  return /(?:docker|kubepods|libpod|lxc)[/\-.]/.test(cgroup ?? "");
}

export async function readSystemMetricsScope(platform: NodeJS.Platform = process.platform,
  read: ReadSystemText = readSystemText): Promise<SystemMetricsScope> {
  if (platform !== "linux") return { kind: "computer", platform, withinWsl: false };
  const [release, cgroup, docker, podman, systemd] = await Promise.all([
    read("/proc/sys/kernel/osrelease"), read("/proc/self/cgroup"), read("/.dockerenv"), read("/run/.containerenv"),
    read("/run/systemd/container"),
  ]);
  const withinWsl = /microsoft|wsl/i.test(release ?? "");
  if (isContainerEnvironment(cgroup, docker, podman, systemd)) return { kind: "container", platform, withinWsl };
  if (withinWsl) return { kind: "wsl", platform, withinWsl };
  return { kind: "computer", platform, withinWsl: false };
}
