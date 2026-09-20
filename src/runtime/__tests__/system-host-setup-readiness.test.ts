import { describe, expect, test, vi } from "vitest";
import { readHostReadiness } from "../../web-ui/system-host-setup/readiness.js";
import type { resolveSystemTarget } from "../../../plugins/system/source/targets.js";

const unpaired = { paired: false, connected: false } as const;
const resolveTarget = () => vi.fn<typeof resolveSystemTarget>(async (id) => ({
  id, transport: id === "windows" ? "wsl_interop" : "native", shell: "/fixture/shell",
}));

describe("installation host readiness", () => {
  test("native Mac uses the existing direct target and needs no setup", async () => {
    const resolve = resolveTarget();
    expect(await readHostReadiness(unpaired, {
      facts: { platform: "darwin", kernelRelease: "Darwin", containerMarker: false },
      resolveTarget: resolve,
    })).toMatchObject({ ready: true, route: "native", platforms: [], restartRequired: false });
    expect(resolve).toHaveBeenCalledExactlyOnceWith("macos");
  });

  test("container markers take priority over a WSL kernel and require a host connection", async () => {
    const resolve = resolveTarget();
    expect(await readHostReadiness(unpaired, {
      facts: { platform: "linux", kernelRelease: "microsoft-standard-WSL2", containerMarker: true },
      resolveTarget: resolve,
    })).toMatchObject({ ready: false, environment: "container", platforms: ["windows", "macos"], restartRequired: false });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("WSL readiness depends on the real Windows execution probe", async () => {
    const resolve = resolveTarget();
    const dependencies = {
      facts: { platform: "linux" as const, kernelRelease: "microsoft-standard-WSL2" },
      distribution: "Ubuntu-test",
      resolveTarget: resolve,
    };
    expect(await readHostReadiness(unpaired, dependencies)).toMatchObject({
      ready: true, environment: "wsl", route: "wsl_interop", platforms: [],
    });
    resolve.mockRejectedValueOnce(new Error("exec format error"));
    expect(await readHostReadiness(unpaired, dependencies)).toMatchObject({
      ready: false, platforms: ["windows"], restartRequired: true, distribution: "Ubuntu-test",
    });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  test("offline paired computer does not fall back to another native machine", async () => {
    const resolve = resolveTarget();
    expect(await readHostReadiness({ paired: true, connected: false }, {
      facts: { platform: "darwin", kernelRelease: "Darwin" }, resolveTarget: resolve,
    })).toMatchObject({ ready: false, route: "companion", platforms: [] });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("failed native shell discovery never reports ready or prescribes WSL repair", async () => {
    const resolve = resolveTarget().mockRejectedValue(new Error("missing shell"));
    expect(await readHostReadiness(unpaired, {
      facts: { platform: "darwin", kernelRelease: "Darwin" }, resolveTarget: resolve,
    })).toMatchObject({ ready: false, environment: "native", platforms: [], restartRequired: false });
  });
});
