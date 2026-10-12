import { describe, expect, test, vi } from "vitest";

import { defaultDiskProbePath } from "../../../plugins/system-probe/source/disk-path.js";
import { readMachineLoad } from "../../../plugins/system-probe/source/machine-load.js";

describe("system-probe host metric semantics", () => {
  test("does not present the Windows load-average sentinel as a measured idle CPU", () => {
    const readLoadAverage = vi.fn(() => [0, 0, 0]);
    expect(readMachineLoad("win32", 8, readLoadAverage)).toEqual({
      loadAverage: null,
      loadLevel: "unsupported",
    });
    expect(readLoadAverage).not.toHaveBeenCalled();
  });

  test.each([
    ["linux", [1, 2, 3], 4, "low"],
    ["darwin", [2, 3, 4], 4, "moderate"],
    ["linux", [4, 5, 6], 4, "high"],
    ["linux", [0.75, 1, 2], 0, "moderate"],
  ] as const)(
    "preserves %s load measurement and classification",
    (platform, averages, cpuCount, loadLevel) => {
      const load = readMachineLoad(platform, cpuCount, () => [...averages]);
      expect(load).toEqual({ loadAverage: averages, loadLevel });
      expect(Object.isFrozen(load.loadAverage)).toBe(true);
    },
  );

  test.each([
    "C:\\ABot\\runtime",
    "D:\\Runtime Data",
    "\\\\server\\share\\runtime",
  ])(
    "uses the configured Windows runtime location for disk statistics: %s",
    (root) => {
      expect(defaultDiskProbePath(root, "win32")).toBe(root);
    },
  );

  test.each(["linux", "darwin"] as const)(
    "retains the %s root filesystem default",
    (platform) => {
      expect(defaultDiskProbePath("/runtime/root", platform)).toBe("/");
    },
  );
});
