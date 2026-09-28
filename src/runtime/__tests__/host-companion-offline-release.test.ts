import { afterEach, expect, test, vi } from "vitest";
import { readHostStatus } from "../../computer-access/companion/broker-client.js";
import { COMPANION_RELEASE_VERSION } from "../../computer-access/companion/release-version.js";
import { COMPUTER_CAPABILITY } from "../../computer-access/computer/native-validation.js";
import { readHostReadiness } from "../../web-ui/system-host-setup/readiness.js";
import {
  hostCompanionFixture,
  nextHostMessage,
  testHostIdentity,
} from "./support/host-companion-fixture.js";

type Fixture = Awaited<ReturnType<typeof hostCompanionFixture>>;
const fixtures: Fixture[] = [];
const facts = {
  platform: "linux" as const,
  kernelRelease: "Linux",
  containerMarker: true,
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

async function setup() {
  const fixture = await hostCompanionFixture();
  fixtures.push(fixture);
  return { fixture, grant: await fixture.pair() };
}

async function activate(
  fixture: Fixture,
  grant: { hostId: string; credential: string },
  companionVersion: number,
) {
  const socket = await fixture.open(grant.credential);
  const ready = nextHostMessage(socket);
  socket.send(
    JSON.stringify({
      type: "hello",
      version: 1,
      hostId: grant.hostId,
      identity: testHostIdentity,
      companionVersion,
      capabilities: [COMPUTER_CAPABILITY],
    }),
  );
  expect(await ready).toMatchObject({ type: "ready", hostId: grant.hostId });
  return socket;
}

async function waitOffline(fixture: Fixture) {
  await vi.waitFor(async () => {
    expect((await readHostStatus(fixture.rootDir)).connected).toBe(false);
  });
  return readHostStatus(fixture.rootDir);
}

test.each([2, COMPANION_RELEASE_VERSION + 1])(
  "authenticated release %s stays known offline and governs repair without retaining live capabilities",
  async (version) => {
    const { fixture, grant } = await setup();
    const socket = await activate(fixture, grant, version);
    const online = await readHostStatus(fixture.rootDir);
    expect(online.companion?.installedVersion).toBe(version);
    socket.terminate();
    const offline = await waitOffline(fixture);
    expect(offline).toMatchObject({
      paired: true,
      connected: false,
      hostId: grant.hostId,
      companion: online.companion,
    });
    expect(offline).not.toHaveProperty("capabilities");
    expect(offline).not.toHaveProperty("connectionId");
    const readiness = await readHostReadiness(offline, { facts });
    expect(readiness.ready).toBe(false);
    expect(readiness.platforms).toEqual(
      version > COMPANION_RELEASE_VERSION ? [] : ["windows"],
    );
    expect(readiness.companionUpdateRequired === true).toBe(
      version <= COMPANION_RELEASE_VERSION,
    );
  },
);

test("a same-host authenticated reconnect replaces earlier release evidence", async () => {
  const { fixture, grant } = await setup();
  const first = await activate(fixture, grant, 2);
  first.terminate();
  await waitOffline(fixture);
  const replacement = await activate(
    fixture,
    grant,
    COMPANION_RELEASE_VERSION + 1,
  );
  replacement.terminate();
  const offline = await waitOffline(fixture);
  expect(offline.companion?.installedVersion).toBe(
    COMPANION_RELEASE_VERSION + 1,
  );
  expect((await readHostReadiness(offline, { facts })).platforms).toEqual([]);
});

test("revocation and re-pairing never project the previous computer's known release", async () => {
  const { fixture, grant } = await setup();
  await activate(fixture, grant, COMPANION_RELEASE_VERSION + 1);
  expect((await fixture.api("", "DELETE")).status).toBe(200);
  expect(await readHostStatus(fixture.rootDir)).toEqual({
    paired: false,
    connected: false,
  });
  const replacement = await fixture.pair();
  expect(replacement.hostId).not.toBe(grant.hostId);
  const offline = await readHostStatus(fixture.rootDir);
  expect(offline).not.toHaveProperty("companion");
  expect((await readHostReadiness(offline, { facts })).platforms).toEqual([
    "windows",
  ]);
});

test("a fresh service does not invent or persist offline release knowledge", async () => {
  const { fixture, grant } = await setup();
  await activate(fixture, grant, COMPANION_RELEASE_VERSION + 1);
  await fixture.restart();
  const offline = await readHostStatus(fixture.rootDir);
  expect(offline).toMatchObject({
    paired: true,
    connected: false,
    hostId: grant.hostId,
  });
  expect(offline).not.toHaveProperty("companion");
  expect(await readHostReadiness(offline, { facts })).toMatchObject({
    companionUpdateRequired: true,
    platforms: ["windows"],
  });
});
