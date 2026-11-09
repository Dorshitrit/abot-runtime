export function metricPercent(value) { return Number.isFinite(value) ? `${Math.round(value)}%` : "—"; }
function gibibytes(value) { return (value / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 1 }); }

export function metricsStatusLabel(status) {
  if (status === "live") return "Live";
  if (status === "connecting") return "Connecting…";
  return "Unavailable";
}

export function metricsScopePresentation(scope) {
  const platform = { darwin: "macOS", win32: "Windows", linux: "Linux" }[scope?.platform] || "System";
  if (scope?.kind === "container") return {
    label: scope.withinWsl ? "Container · WSL" : "Container",
    detail: "Container usage and limits. Not the whole host computer.",
  };
  if (scope?.kind === "wsl") return { label: "WSL", detail: "Linux environment. Not the Windows host." };
  return { label: "Computer", detail: `${platform} · Computer running ABot, not necessarily this browser.` };
}

export function metricsCpuDetail(cpu, scope) {
  if (cpu.reason === "sampling") return "Measuring…";
  if (cpu.reason === "unavailable") return "Counters not exposed";
  return `${Number(cpu.capacity.toFixed(2))} CPU capacity · ${scope}`;
}

export function metricsMemoryDetail(memory) {
  if (memory.usedBytes === null || memory.totalBytes === null) return "Counters not exposed";
  return `${gibibytes(memory.usedBytes)} / ${gibibytes(memory.totalBytes)} GiB`;
}

export function metricsMemoryBasis(basis) {
  if (basis === "cgroup") return "Container memory including cache, relative to its available limit.";
  if (basis === "vm_stat") return "App, wired and compressed memory; excludes reclaimable file cache and purgeable pages.";
  if (basis === "available") return "Total minus available memory; reclaimable cache is available.";
  return "Total minus free memory; operating-system cache accounting may differ from other monitors.";
}

export function metricsMemoryLabel(memory, scope) {
  if (memory.basis === "cgroup") return "Memory incl. cache";
  if (memory.basis === "free" && scope.platform !== "win32") return "Memory incl. cache";
  return "Memory used";
}
