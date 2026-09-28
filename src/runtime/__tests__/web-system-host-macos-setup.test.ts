import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readHostStatus } from "../../computer-access/companion/broker-client.js";
import { readBrokerLocation } from "../../computer-access/companion/broker-location.js";
import { hostCompanionFixture } from "./support/host-companion-fixture.js";

vi.mock("../../web-ui/system-host-setup/companion-bundle.js", () => ({
  readInstallerCompanionBundle: async () => Buffer.from("fixture-companion-bundle"),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test.skipIf(process.platform === "win32")("Mac setup prepares a real broker before issuing the installer and pairing grant", async () => {
  const fixture = await hostCompanionFixture();
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  vi.stubEnv("TMPDIR", join(fixture.rootDir, "long-launch-directory-".repeat(6)));
  let socketDirectory: string | undefined;
  try {
    const response = await fetch(fixture.base + "/web-api/runtime/system-host/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "macos" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      filename: "ABot-Connect-Computer-macOS.zip",
      mimeType: "application/zip",
      contentBase64: expect.any(String),
      expiresAt: expect.any(String),
    });
    const location = readBrokerLocation(fixture.rootDir);
    expect(location).toBeDefined();
    socketDirectory = dirname(location!.socketPath);
    expect(Buffer.byteLength(location!.socketPath)).toBeLessThanOrEqual(103);
    expect(await readHostStatus(fixture.rootDir)).toEqual({ paired: false, connected: false });
    const grant = await fixture.pair();
    const client = await fixture.activate(grant);
    try {
      expect(await readHostStatus(fixture.rootDir)).toMatchObject({
        paired: true,
        connected: true,
        hostId: grant.hostId,
      });
    } finally {
      client.terminate();
    }
  } finally {
    await fixture.close();
    if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
  }
});
