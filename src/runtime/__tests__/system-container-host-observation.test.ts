import { describe, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { isWslHostRuntime, observeSystemHost, readSystemHostFacts } from "../../computer-access/host-observation.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: vi.fn(() => false),
}));

describe("container evidence takes precedence over a shared WSL kernel", () => {
  test.each(["6.6.0-microsoft-standard-WSL2", "6.8.0-generic"])("marked kernel %s cannot establish a Windows host", (kernelRelease) => {
    const facts = { platform: "linux", kernelRelease, containerMarker: true } as const;
    expect(isWslHostRuntime(facts)).toBe(false);
    expect(observeSystemHost(facts)).toEqual({
      runtimeOs: "linux", kernelRelease, environment: "container",
      inferredHostOs: "unknown", hostInferenceSource: "container_marker",
      windowsExecutionRequiresProbe: false, guiSessionStatus: "not_checked",
    });
  });

  test("native WSL still requires a real Windows execution probe", () => {
    const facts = { platform: "linux", kernelRelease: "6.6-microsoft-WSL2", containerMarker: false } as const;
    expect(isWslHostRuntime(facts)).toBe(true);
    expect(observeSystemHost(facts)).toMatchObject({
      runtimeOs: "linux", environment: "wsl_guest", inferredHostOs: "windows",
      windowsExecutionRequiresProbe: true, guiSessionStatus: "not_checked",
    });
  });

  test("native macOS is not reinterpreted as a container or WSL", () => {
    expect(observeSystemHost({ platform: "darwin", kernelRelease: "24.5.0", containerMarker: true })).toMatchObject({
      runtimeOs: "macos", environment: "not_identified_as_wsl",
      inferredHostOs: "macos", hostInferenceSource: "runtime_platform_only",
    });
  });

  test.each(["/.dockerenv", "/run/.containerenv"])("default observation reads actual container marker %s", (marker) => {
    vi.mocked(existsSync).mockImplementation((path) => path === marker);
    expect(readSystemHostFacts().containerMarker).toBe(true);
    vi.mocked(existsSync).mockReturnValue(false);
    expect(readSystemHostFacts().containerMarker).toBe(false);
  });
});
