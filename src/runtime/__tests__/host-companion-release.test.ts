import { expect, test } from "vitest";
import {
  companionReleaseStatus,
  COMPANION_RELEASE_VERSION,
} from "../../computer-access/companion/release-version.js";
import { readHostStatus } from "../../computer-access/companion/broker-client.js";
import {
  hostCompanionFixture,
  nextHostMessage,
  testHostIdentity,
} from "./support/host-companion-fixture.js";

test.each([
  undefined,
  1,
  COMPANION_RELEASE_VERSION,
  COMPANION_RELEASE_VERSION + 1,
])(
  "retains reported companion release %s after disconnect without rejecting older or newer hosts",
  async (companionVersion) => {
    const fixture = await hostCompanionFixture();
    try {
      const grant = await fixture.pair();
      const socket = await fixture.open(grant.credential);
      const ready = nextHostMessage(socket);
      socket.send(
        JSON.stringify({
          type: "hello",
          version: 1,
          identity: testHostIdentity,
          hostId: grant.hostId,
          companionVersion,
        }),
      );
      await ready;
      const companion = companionReleaseStatus(companionVersion);
      expect((await fixture.api()).body).toMatchObject({
        connected: true,
        companion,
      });
      expect(await readHostStatus(fixture.rootDir)).toMatchObject({
        connected: true,
        companion,
      });
      socket.terminate();
      await new Promise<void>((resolve) => socket.once("close", resolve));
      for (const status of [
        (await fixture.api()).body,
        await readHostStatus(fixture.rootDir),
      ]) {
        expect(status).toMatchObject({
          paired: true,
          connected: false,
          hostId: grant.hostId,
          companion,
        });
        expect(status.connectionId).toBeUndefined();
        expect(status.capabilities).toBeUndefined();
      }
    } finally {
      await fixture.close();
    }
  },
);

test.each([3, 4, 5])(
  "release %s companions are offered the current companion fixes online and offline",
  async (installedVersion) => {
    const fixture = await hostCompanionFixture();
    const companion = {
      installedVersion,
      availableVersion: COMPANION_RELEASE_VERSION,
      updateAvailable: true,
    };
    try {
      const grant = await fixture.pair();
      const socket = await fixture.open(grant.credential);
      const ready = nextHostMessage(socket);
      socket.send(
        JSON.stringify({
          type: "hello",
          version: 1,
          identity: testHostIdentity,
          hostId: grant.hostId,
          companionVersion: installedVersion,
        }),
      );
      await ready;
      expect((await fixture.api()).body).toMatchObject({
        connected: true,
        companion,
      });
      expect(await readHostStatus(fixture.rootDir)).toMatchObject({
        connected: true,
        companion,
      });

      const closed = new Promise<void>((resolve) =>
        socket.once("close", resolve),
      );
      socket.terminate();
      await closed;
      expect((await fixture.api()).body).toMatchObject({
        connected: false,
        companion,
      });
      expect(await readHostStatus(fixture.rootDir)).toMatchObject({
        connected: false,
        companion,
      });
      expect(companionReleaseStatus(COMPANION_RELEASE_VERSION)).toEqual({
        installedVersion: COMPANION_RELEASE_VERSION,
        availableVersion: COMPANION_RELEASE_VERSION,
        updateAvailable: false,
      });
    } finally {
      await fixture.close();
    }
  },
);

test.each([0, -1, 1.5, "2", {}, null])(
  "malformed release %j is not treated as up-to-date",
  (version) => {
    expect(companionReleaseStatus(version)).toMatchObject({
      installedVersion: null,
      updateAvailable: true,
    });
  },
);
