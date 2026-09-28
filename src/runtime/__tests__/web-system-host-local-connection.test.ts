import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import type WebSocket from "ws";
import { afterEach, expect, test, vi } from "vitest";
import { readBrokerLocation } from "../../computer-access/companion/broker-location.js";
import { installLocalMacCompanion } from "../../computer-access/companion/local-installation.js";
import { COMPANION_RELEASE_VERSION } from "../../computer-access/companion/release-version.js";
import { COMPUTER_CAPABILITY } from "../../computer-access/computer/native-validation.js";
import { OBSERVATION_CAPABILITY } from "../../computer-access/companion/observation-protocol.js";
import { hostCompanionFixture, nextHostMessage } from "./support/host-companion-fixture.js";

vi.mock("../../computer-access/companion/local-installation.js", async (original) => ({
  ...await original<typeof import("../../computer-access/companion/local-installation.js")>(),
  installLocalMacCompanion: vi.fn(),
}));
vi.mock("../../web-ui/system-host-setup/companion-bundle.js", () => ({
  readInstallerCompanionBundle: async () => Buffer.from("installed fixture bundle"),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

test.skipIf(process.platform === "win32")("local setup completes real pairing and authenticated connection without a download", async () => {
  const fixture = await hostCompanionFixture();
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  let active: WebSocket | undefined;
  const identity = { name: "QA Mac", os: "macos", user: "tester", homeDir: "/Users/tester" };
  try {
    const before = await fixture.api();
    expect(before.body.readiness).toMatchObject({ localSetupAvailable: true });
    vi.mocked(installLocalMacCompanion).mockImplementationOnce(async (input) => {
      expect(input.bundle.toString()).toBe("installed fixture bundle");
      expect(input.url).toBe(fixture.base);
      const pairing = await fixture.open(input.code);
      const paired = nextHostMessage(pairing);
      pairing.send(JSON.stringify({ type: "hello", version: 1, identity }));
      const grant = await paired;
      pairing.terminate();
      active = await fixture.open(String(grant.credential));
      const ready = nextHostMessage(active);
      active.send(JSON.stringify({ type: "hello", version: 1, identity, hostId: grant.hostId,
        companionVersion: COMPANION_RELEASE_VERSION,
        capabilities: [OBSERVATION_CAPABILITY, COMPUTER_CAPABILITY] }));
      expect(await ready).toMatchObject({ type: "ready" });
    });
    expect(await fixture.api("/connect-local", "POST", fixture.base)).toEqual({ status: 200, body: { ok: true } });
    expect((await fixture.api()).body).toMatchObject({ paired: true, connected: true,
      identity, readiness: { ready: true, route: "companion" } });
  } finally {
    active?.terminate();
    const location = readBrokerLocation(fixture.rootDir);
    await fixture.close();
    if (location) await rm(dirname(location.socketPath), { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("setup blocks conflicting pairing, revoke and download grants until it finishes", async () => {
  const fixture = await hostCompanionFixture();
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  let finish!: () => void;
  vi.mocked(installLocalMacCompanion).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const setup = fixture.api("/connect-local", "POST");
  try {
    await vi.waitFor(() => expect(installLocalMacCompanion).toHaveBeenCalledOnce());
    expect((await fixture.api("/pairing", "POST")).status).toBe(409);
    expect((await fixture.api("", "DELETE")).status).toBe(409);
    const download = await fetch(fixture.base + "/web-api/runtime/system-host/setup", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ platform: "macos" }),
    });
    expect(download.status).toBe(409);
  } finally {
    finish?.();
    await setup;
    const location = readBrokerLocation(fixture.rootDir);
    await fixture.close();
    if (location) await rm(dirname(location.socketPath), { recursive: true, force: true });
  }
});
