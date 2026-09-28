import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import {
  executeHostOperation,
  readHostStatus,
} from "../../computer-access/companion/broker-client.js";
import { readBrokerLocation } from "../../computer-access/companion/broker-location.js";
import { hostCompanionFixture } from "./support/host-companion-fixture.js";

type Fixture = Awaited<ReturnType<typeof hostCompanionFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

async function setup() {
  const fixture = await hostCompanionFixture();
  fixtures.push(fixture);
  const grant = await fixture.pair();
  return { fixture, grant, active: await activate(fixture, grant) };
}

async function activate(
  fixture: Fixture,
  grant: { hostId: string; credential: string },
) {
  const socket = await fixture.activate(grant);
  const received: Record<string, unknown>[] = [];
  socket.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString()) as Record<string, unknown>;
    received.push(message);
    if (message.type !== "execute") return;
    socket.send(
      JSON.stringify({
        type: "result",
        id: message.id,
        result: {
          ok: true,
          output: "fixture observation",
          producedNewInformation: true,
        },
      }),
    );
  });
  const status = await readHostStatus(fixture.rootDir);
  expect(status.connected).toBe(true);
  return { socket, received, connectionId: status.connectionId! };
}

function command(hostId: string, connectionId: string) {
  return {
    hostId,
    connectionId,
    operation: "system_command" as const,
    params: { target: "windows", command: "fixture", cwd: "C:\\" },
  };
}

async function disconnect(
  fixture: Fixture,
  active: Awaited<ReturnType<typeof activate>>,
) {
  active.socket.terminate();
  await vi.waitFor(async () =>
    expect((await readHostStatus(fixture.rootDir)).connected).toBe(false),
  );
  expect(await readHostStatus(fixture.rootDir)).not.toHaveProperty(
    "connectionId",
  );
}

test("connected status exposes a UUID incarnation without changing the native execute envelope", async () => {
  const { fixture, grant, active } = await setup();
  expect(active.connectionId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(
    await executeHostOperation(
      fixture.rootDir,
      command(grant.hostId, active.connectionId),
    ),
  ).toMatchObject({ ok: true });
  expect(active.received).toHaveLength(1);
  expect(active.received[0]).toMatchObject({
    type: "execute",
    hostId: grant.hostId,
  });
  expect(active.received[0]).not.toHaveProperty("connectionId");
});

test.each([undefined, "not-a-uuid", randomUUID()])(
  "missing or stale connection binding %s never dispatches",
  async (connectionId) => {
    const { fixture, grant, active } = await setup();
    const result = await executeHostOperation(
      fixture.rootDir,
      command(grant.hostId, connectionId as string),
    );
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(grant.hostId);
    expect(JSON.stringify(result)).not.toContain(active.connectionId);
    expect(active.received).toEqual([]);
  },
);

test("broker lookup failures preserve dispatch evidence without exposing the private binding", async () => {
  const hostId = randomUUID();
  const connectionId = randomUUID();
  const result = await executeHostOperation(
    "/fixture/unavailable-runtime",
    command(hostId, connectionId),
  );
  expect(result).toMatchObject({
    ok: false,
    errorCode: "system_host_unavailable",
    data: { outcome: "not_dispatched", retrySafe: true },
  });
  expect(JSON.stringify(result)).not.toContain(hostId);
  expect(JSON.stringify(result)).not.toContain(connectionId);
});

test("same-host reconnection rotates the binding and refuses the previously approved connection", async () => {
  const { fixture, grant, active } = await setup();
  await disconnect(fixture, active);
  const replacement = await activate(fixture, grant);
  expect(replacement.connectionId).not.toBe(active.connectionId);
  expect(
    await executeHostOperation(
      fixture.rootDir,
      command(grant.hostId, active.connectionId),
    ),
  ).toMatchObject({ ok: false });
  expect(replacement.received).toEqual([]);
  expect(
    await executeHostOperation(
      fixture.rootDir,
      command(grant.hostId, replacement.connectionId),
    ),
  ).toMatchObject({ ok: true });
  expect(replacement.received).toHaveLength(1);
});

test("broker service restart preserves the pairing but rejects the old connection binding", async () => {
  const { fixture, grant, active } = await setup();
  await fixture.restart();
  expect(await readHostStatus(fixture.rootDir)).toMatchObject({
    paired: true,
    connected: false,
    hostId: grant.hostId,
  });
  expect(await readHostStatus(fixture.rootDir)).not.toHaveProperty(
    "connectionId",
  );
  const replacement = await activate(fixture, grant);
  expect(replacement.connectionId).not.toBe(active.connectionId);
  expect(
    await executeHostOperation(
      fixture.rootDir,
      command(grant.hostId, active.connectionId),
    ),
  ).toMatchObject({ ok: false });
  expect(replacement.received).toEqual([]);
});

test("revocation and re-pairing cannot reuse old host or connection authority", async () => {
  const { fixture, grant, active } = await setup();
  expect((await fixture.api("", "DELETE")).status).toBe(200);
  expect(await readHostStatus(fixture.rootDir)).toEqual({
    paired: false,
    connected: false,
  });
  const nextGrant = await fixture.pair();
  const replacement = await activate(fixture, nextGrant);
  expect(nextGrant.hostId).not.toBe(grant.hostId);
  expect(replacement.connectionId).not.toBe(active.connectionId);
  expect(
    await executeHostOperation(
      fixture.rootDir,
      command(grant.hostId, replacement.connectionId),
    ),
  ).toMatchObject({ ok: false });
  expect(
    await executeHostOperation(
      fixture.rootDir,
      command(nextGrant.hostId, active.connectionId),
    ),
  ).toMatchObject({ ok: false });
  expect(replacement.received).toEqual([]);
});

test("the authenticated broker rejects an execute request without a connection incarnation", async () => {
  const { fixture, grant, active } = await setup();
  const location = readBrokerLocation(fixture.rootDir)!;
  const result = await new Promise<unknown>((resolve, reject) => {
    const socket = connect(location.socketPath);
    let response = "";
    socket.setTimeout(2_000, () =>
      socket.destroy(new Error("fixture_broker_timeout")),
    );
    socket.once("error", reject);
    socket.once("connect", () =>
      socket.write(
        JSON.stringify({
          version: 1,
          token: location.token,
          kind: "execute",
          hostId: grant.hostId,
          operation: "system_command",
          params: {},
        }) + "\n",
      ),
    );
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.once("end", () => {
      try {
        resolve(JSON.parse(response));
      } catch (error) {
        reject(error);
      }
    });
  });
  expect(result).toEqual({ ok: false, error: "invalid_host_connection" });
  expect(active.received).toEqual([]);
});
