import { expect, test, vi } from "vitest";
import type { HostStatus } from "../../computer-access/companion/protocol.js";
import {
  companionReleaseStatus,
  COMPANION_RELEASE_VERSION,
} from "../../computer-access/companion/release-version.js";
import { COMPUTER_CAPABILITY } from "../../computer-access/computer/native-validation.js";
import { readHostReadiness } from "../../web-ui/system-host-setup/readiness.js";
// @ts-expect-error Browser-only module.
import { createSystemHostConnectionManager } from "../../web-ui/app/components/system-host/manager.js";
// @ts-expect-error Browser-only module.
import { renderSystemHostConnection } from "../../web-ui/app/components/system-host/rendering.js";

function companionStatus(
  os: "windows" | "macos" | "linux",
  version: number | undefined,
  capabilities?: readonly string[],
): HostStatus {
  return {
    paired: true,
    connected: true,
    connectionId: "connected-fixture",
    identity: {
      name: "Existing computer",
      os,
      user: "owner",
      homeDir: "/home/owner",
    },
    companion: companionReleaseStatus(version),
    capabilities,
  };
}

test.each(["windows", "macos", "linux"] as const)(
  "a version 2 %s companion offers its own platform update without probing another computer",
  async (os) => {
    const resolveTarget = vi.fn();
    const readiness = await readHostReadiness(
      companionStatus(os, 2, ["passive-observations-v1"]),
      {
        facts: {
          platform: "linux",
          kernelRelease: "microsoft-standard-WSL2",
          containerMarker: true,
        },
        resolveTarget,
      },
    );
    expect(readiness).toMatchObject({
      ready: false,
      route: "companion",
      environment: "container",
      companionUpdateRequired: true,
      platforms: [os],
      restartRequired: false,
    });
    expect(resolveTarget).not.toHaveBeenCalled();
  },
);

test.each([undefined, COMPANION_RELEASE_VERSION])(
  "a companion without computer capability cannot become ready from release %s alone",
  async (version) => {
    expect(
      await readHostReadiness(companionStatus("windows", version), {
        facts: { platform: "linux", kernelRelease: "microsoft-standard-WSL2" },
      }),
    ).toMatchObject({
      ready: false,
      environment: "wsl",
      companionUpdateRequired: true,
      platforms: ["windows"],
      restartRequired: false,
    });
  },
);

test.each([COMPANION_RELEASE_VERSION, COMPANION_RELEASE_VERSION + 1])(
  "advertised computer support at release %s makes the companion ready without a required update",
  async (version) => {
    const readiness = await readHostReadiness(
      companionStatus("macos", version, [COMPUTER_CAPABILITY, "passive-observations-v1"]),
      { facts: { platform: "darwin", kernelRelease: "Darwin" } },
    );
    expect(readiness).toMatchObject({
      ready: true,
      route: "companion",
      platforms: [],
      restartRequired: false,
    });
    expect(readiness.companionUpdateRequired).not.toBe(true);
  },
);

test("a newer incompatible companion is unavailable without offering a downgrade", async () => {
  const readiness = await readHostReadiness(
    companionStatus("linux", COMPANION_RELEASE_VERSION + 1, []),
    {
      facts: {
        platform: "linux",
        kernelRelease: "Linux",
        containerMarker: true,
      },
    },
  );
  expect(readiness).toMatchObject({
    ready: false,
    route: "companion",
    platforms: [],
    restartRequired: false,
  });
  expect(readiness.companionUpdateRequired).not.toBe(true);
});

test.each([
  { os: "windows", action: 'data-system-host-install="windows"' },
  { os: "macos", action: 'data-system-host-mac="manual"' },
  { os: "linux", action: 'data-system-host-install="linux"' },
] as const)(
  "an offline paired $os computer keeps setup available using its persisted identity",
  async ({ os, action }) => {
    const status: HostStatus = {
      paired: true,
      connected: false,
      identity: companionStatus(os, undefined).identity,
    };
    const resolveTarget = vi.fn();
    const readiness = await readHostReadiness(status, {
      facts: { platform: "linux", kernelRelease: "microsoft-standard-WSL2" },
      resolveTarget,
    });
    expect(readiness).toMatchObject({
      ready: false,
      route: "companion",
      companionUpdateRequired: true,
      platforms: [os],
      restartRequired: false,
    });
    const html = renderSystemHostConnection({
      snapshot: { ...status, readiness },
      supported: true,
    });
    expect(html).toContain("Paired · offline");
    expect(html).toContain(action);
    expect(resolveTarget).not.toHaveBeenCalled();
  },
);

test("known newer release metadata still prevents offering an offline downgrade", async () => {
  const readiness = await readHostReadiness(
    {
      ...companionStatus("windows", COMPANION_RELEASE_VERSION + 1, [
        COMPUTER_CAPABILITY,
      ]),
      connected: false,
      connectionId: undefined,
    },
    {
      facts: {
        platform: "linux",
        kernelRelease: "Linux",
        containerMarker: true,
      },
    },
  );
  expect(readiness.ready).toBe(false);
  expect(readiness.platforms).toEqual([]);
  expect(readiness.companionUpdateRequired).not.toBe(true);
});

test("a failed replacement keeps setup downloadable without unpairing until a capable companion reconnects", async () => {
  let status: HostStatus = companionStatus("windows", 2, [
    "passive-observations-v1",
  ]);
  const downloadSetup = vi.fn(async () => ({
    filename: "setup.cmd",
    restartRequired: false,
  }));
  const revokeConnection = vi.fn();
  const root = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const manager = createSystemHostConnectionManager({
    loadConnection: async () => ({
      ...status,
      readiness: await readHostReadiness(status, {
        facts: { platform: "linux", kernelRelease: "microsoft-standard-WSL2" },
      }),
    }),
    downloadSetup,
    revokeConnection,
    saveDownload: vi.fn(),
    schedulePoll: vi.fn(),
    cancelPoll: vi.fn(),
    documentRoot: {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  manager.mount(root);
  try {
    manager.setActive(true);
    await vi.waitFor(() => expect(manager.state.busy).toBe(false));
    expect(await manager.install("windows")).toBe(true);
    status = { paired: true, connected: false, identity: status.identity };
    await manager.load();
    expect(root.innerHTML).toContain("Paired · offline");
    expect(root.innerHTML).toContain('data-system-host-install="windows"');
    expect(manager.state.downloaded).not.toBeNull();
    expect(await manager.install("windows")).toBe(true);
    expect(downloadSetup).toHaveBeenCalledTimes(2);
    expect(revokeConnection).not.toHaveBeenCalled();

    status = companionStatus("windows", COMPANION_RELEASE_VERSION, [
      COMPUTER_CAPABILITY, "passive-observations-v1",
    ]);
    await manager.load();
    expect(manager.state.snapshot.readiness.ready).toBe(true);
    expect(manager.state.downloaded).toBeNull();
    expect(root.innerHTML).not.toContain("data-system-host-install=");
  } finally {
    manager.dispose();
  }
});
