import { execFile } from "node:child_process";
import { win32 } from "node:path";
import type { SystemMetricsScope, SystemTemperature } from "./contracts.js";
import { listSystemDirectory, readSystemText, type ReadSystemText } from "./system-files.js";

const notExposed: SystemTemperature = { celsius: null, sensor: null, scope: null, reason: "not_exposed" };

function temperatureReading(value: number, sensor: string): SystemTemperature | null {
  if (!Number.isFinite(value) || value < -20 || value > 150) return null;
  return { celsius: Math.round(value * 10) / 10, sensor: sensor.replace(/[\x00-\x1f]/g, "").slice(0, 80),
    scope: "computer", reason: null };
}

async function readLinuxTemperature(read: ReadSystemText, list: typeof listSystemDirectory): Promise<SystemTemperature> {
  const chips = (await list("/sys/class/hwmon")).filter(name => /^hwmon\d+$/.test(name)).slice(0, 16);
  for (const chip of chips) {
    const root = `/sys/class/hwmon/${chip}`;
    const name = await read(`${root}/name`);
    // These drivers expose CPU/package temperatures in millidegrees, not raw voltages or disk sensors.
    if (!/^(coretemp|k10temp|zenpower|cpu_thermal|soc_thermal|peci_cputemp)$/.test(name ?? "")) continue;
    const inputs = (await list(root)).filter(file => /^temp\d+_input$/.test(file)).slice(0, 32);
    const readings = await Promise.all(inputs.map(async file => {
      const [raw, label, fault] = await Promise.all([read(`${root}/${file}`),
        read(`${root}/${file.replace("_input", "_label")}`), read(`${root}/${file.replace("_input", "_fault")}`)]);
      if (!raw || fault === "1") return null;
      return temperatureReading(Number(raw) / 1000, `${name} · ${label || "CPU"}`);
    }));
    const available = readings.filter((value): value is SystemTemperature => value !== null);
    if (available.length) return available.reduce((a, b) => a.celsius! >= b.celsius! ? a : b);
  }
  const zones = (await list("/sys/class/thermal")).filter(name => /^thermal_zone\d+$/.test(name)).slice(0, 32);
  for (const zone of zones) {
    const root = `/sys/class/thermal/${zone}`;
    const [kind, raw] = await Promise.all([read(`${root}/type`), read(`${root}/temp`)]);
    if (!kind || !raw || !/cpu|soc|pkg|acpitz/i.test(kind)) continue;
    const reading = temperatureReading(Number(raw) / 1000, kind);
    if (reading) return reading;
  }
  return notExposed;
}

export function parseWindowsThermalZones(output: string): SystemTemperature {
  try {
    const parsed: unknown = JSON.parse(output);
    const zones = Array.isArray(parsed) ? parsed : [parsed];
    for (const zone of zones.slice(0, 16)) {
      if (!zone || typeof zone !== "object" || typeof zone.CurrentTemperature !== "number") continue;
      // ACPI reports tenths of kelvin; a thermal zone is not necessarily the CPU die.
      const reading = temperatureReading(zone.CurrentTemperature / 10 - 273.15, "ACPI thermal zone");
      if (reading) return reading;
    }
  } catch { /* The OS may not expose ACPI sensor readings to this user. */ }
  return notExposed;
}

function readWindowsThermalZones(): Promise<string> {
  return new Promise(resolve => {
    const executable = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = "Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop | Select-Object -First 16 CurrentTemperature | ConvertTo-Json -Compress";
    execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 1500, maxBuffer: 8192, windowsHide: true, encoding: "utf8" },
      (error, stdout) => resolve(error ? "" : stdout));
  });
}

/** On-demand, slowly cached sensor reads. Never elevates or launches a background monitor. */
export function createTemperatureReader(options: {
  read?: ReadSystemText; list?: typeof listSystemDirectory; windows?: () => Promise<string>; now?: () => number;
} = {}) {
  const now = options.now ?? performance.now.bind(performance);
  let cached: SystemTemperature | undefined;
  let expires = 0;
  let pending: Promise<SystemTemperature> | undefined;
  return async (scope: SystemMetricsScope): Promise<SystemTemperature> => {
    if (cached && now() < expires) return cached;
    if (pending) return pending;
    async function sample(): Promise<SystemTemperature> {
      if (scope.platform === "linux") return readLinuxTemperature(options.read ?? readSystemText, options.list ?? listSystemDirectory);
      if (scope.platform === "win32") return parseWindowsThermalZones(await (options.windows ?? readWindowsThermalZones)());
      return { ...notExposed, reason: "unsupported" };
    }
    pending = sample().catch(() => notExposed);
    try {
      cached = await pending;
      expires = now() + (cached.celsius === null ? 300_000 : 30_000);
      return cached;
    } finally { pending = undefined; }
  };
}
