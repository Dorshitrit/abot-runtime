import { expect, test, vi } from "vitest";
import { createTemperatureReader, parseWindowsThermalZones } from "./temperature.js";
import type { SystemMetricsScope } from "./contracts.js";

const linux: SystemMetricsScope = { kind: "computer", platform: "linux", withinWsl: false };

test("Linux exposes a labelled package sensor, rejects faulted readings and caches polling", async () => {
  const files: Record<string, string> = {
    "/sys/class/hwmon/hwmon0/name": "nvme", "/sys/class/hwmon/hwmon1/name": "coretemp",
    "/sys/class/hwmon/hwmon1/temp1_input": "62000", "/sys/class/hwmon/hwmon1/temp1_label": "Package id 0",
    "/sys/class/hwmon/hwmon1/temp2_input": "99000", "/sys/class/hwmon/hwmon1/temp2_fault": "1",
  };
  const read = vi.fn(async (path: string) => files[path] ?? null);
  const list = vi.fn(async (path: string) => path === "/sys/class/hwmon" ? ["hwmon0", "hwmon1"] : ["temp1_input", "temp2_input"]);
  let now = 0;
  const temperature = createTemperatureReader({ read, list, now: () => now });
  expect(await temperature(linux)).toMatchObject({ celsius: 62, sensor: "coretemp · Package id 0", scope: "computer" });
  const calls = read.mock.calls.length;
  now = 20_000; await temperature(linux); expect(read).toHaveBeenCalledTimes(calls);
  now = 31_000; await temperature(linux); expect(read.mock.calls.length).toBeGreaterThan(calls);
});

test("thermal zone fallback stays labelled as the physical host even when exposed inside a container", async () => {
  const files: Record<string, string> = { "/sys/class/thermal/thermal_zone0/type": "x86_pkg_temp",
    "/sys/class/thermal/thermal_zone0/temp": "48000" };
  const temperature = createTemperatureReader({ read: async path => files[path] ?? null,
    list: async path => path === "/sys/class/thermal" ? ["thermal_zone0"] : [] });
  expect(await temperature({ ...linux, kind: "container" })).toMatchObject({ celsius: 48, scope: "computer", sensor: "x86_pkg_temp" });
});

test("missing sensors remain unavailable and do not spawn helpers on macOS or WSL", async () => {
  const windows = vi.fn(async () => "[]");
  const linuxReader = createTemperatureReader({ read: async () => null, list: async () => [], windows });
  expect((await linuxReader({ ...linux, kind: "wsl", withinWsl: true })).reason).toBe("not_exposed");
  const macReader = createTemperatureReader({ windows });
  expect((await macReader({ kind: "computer", platform: "darwin", withinWsl: false })).reason).toBe("unsupported");
  expect(windows).not.toHaveBeenCalled();
});

test("Windows ACPI readings convert kelvin and never pretend to be CPU die readings", () => {
  expect(parseWindowsThermalZones('[{"CurrentTemperature":3200}]')).toMatchObject({ celsius: 46.9, sensor: "ACPI thermal zone" });
  for (const text of ["", "Access denied", "[]", '{"CurrentTemperature":0}', '{"CurrentTemperature":"3200"}'])
    expect(parseWindowsThermalZones(text).celsius).toBeNull();
});

test("unavailable Windows sensors are cached for five minutes and concurrent reads share one invocation", async () => {
  let now = 0; const windows = vi.fn(async () => "");
  const reader = createTemperatureReader({ windows, now: () => now });
  const scope = { kind: "computer", platform: "win32", withinWsl: false } as const;
  await Promise.all([reader(scope), reader(scope)]); expect(windows).toHaveBeenCalledOnce();
  now = 299_000; await reader(scope); expect(windows).toHaveBeenCalledOnce();
  now = 301_000; await reader(scope); expect(windows).toHaveBeenCalledTimes(2);
});
