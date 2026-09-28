import { expect, test, vi } from "vitest";
import { readHostStatus } from "../../computer-access/companion/broker-client.js";
import { OBSERVATION_CAPABILITY } from "../../computer-access/companion/observation-protocol.js";
import { COMPANION_RELEASE_VERSION } from "../../computer-access/companion/release-version.js";
import { COMPUTER_CAPABILITY } from "../../computer-access/computer/native-validation.js";
import {
  hostCompanionFixture,
  nextHostMessage,
  testHostIdentity,
} from "./support/host-companion-fixture.js";

test("reconnecting a previous passive companion to a current computer companion preserves release and capabilities", async () => {
  const connectionChanged = vi.fn();
  const fixture = await hostCompanionFixture(connectionChanged);
  try {
    const grant = await fixture.pair();
    expect(connectionChanged).toHaveBeenCalledTimes(1);
    const releases = [
      {
        version: 2,
        capabilities: [OBSERVATION_CAPABILITY],
        updateAvailable: true,
      },
      {
        version: COMPANION_RELEASE_VERSION,
        capabilities: [OBSERVATION_CAPABILITY, COMPUTER_CAPABILITY],
        updateAvailable: false,
      },
    ];
    for (const [index, release] of releases.entries()) {
      const socket = await fixture.open(grant.credential);
      const ready = nextHostMessage(socket);
      socket.send(
        JSON.stringify({
          type: "hello",
          version: 1,
          identity: testHostIdentity,
          hostId: grant.hostId,
          companionVersion: release.version,
          capabilities: release.capabilities,
        }),
      );
      expect(await ready).toMatchObject({
        type: "ready",
        hostId: grant.hostId,
      });
      const expected = {
        connected: true,
        companion: {
          installedVersion: release.version,
          availableVersion: COMPANION_RELEASE_VERSION,
          updateAvailable: release.updateAvailable,
        },
        capabilities: release.capabilities,
      };
      const httpStatus = (await fixture.api()).body;
      const brokerStatus = await readHostStatus(fixture.rootDir);
      expect(httpStatus).toMatchObject(expected);
      expect(brokerStatus).toMatchObject(expected);
      expect(httpStatus.capabilities).toEqual(release.capabilities);
      expect(brokerStatus.capabilities).toEqual(release.capabilities);
      expect(connectionChanged).toHaveBeenCalledTimes(2 + index * 2);

      socket.terminate();
      await vi.waitFor(async () => {
        expect((await fixture.api()).body.connected).toBe(false);
      });
      for (const status of [
        (await fixture.api()).body,
        await readHostStatus(fixture.rootDir),
      ]) {
        expect(status).toMatchObject({ paired: true, connected: false });
        expect(status.companion).toEqual(expected.companion);
        expect(status.capabilities).toBeUndefined();
        expect(status.connectionId).toBeUndefined();
      }
      expect(connectionChanged).toHaveBeenCalledTimes(3 + index * 2);
    }
    expect((await fixture.api("", "DELETE")).status).toBe(200);
    for (const status of [
      (await fixture.api()).body,
      await readHostStatus(fixture.rootDir),
    ]) {
      expect(status).toMatchObject({ paired: false, connected: false });
      expect(status.companion).toBeUndefined();
      expect(status.capabilities).toBeUndefined();
      expect(status.connectionId).toBeUndefined();
    }
  } finally {
    await fixture.close();
  }
});
