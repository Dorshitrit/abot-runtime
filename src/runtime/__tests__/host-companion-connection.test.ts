import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectNativeHost } from "../../../plugins/system/source/companion/native-session.js";
import {
  executeHostOperation,
  readHostStatus,
} from "../../../plugins/system/source/companion/broker-client.js";
import {
  hostCompanionFixture,
  nextHostMessage,
  testHostIdentity,
} from "./support/host-companion-fixture.js";

const fixtures: Awaited<ReturnType<typeof hostCompanionFixture>>[] = [];
async function setup() {
  const fixture = await hostCompanionFixture();
  fixtures.push(fixture);
  return fixture;
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

describe("authenticated Docker host connection", () => {
  it("keeps duplicate ownership retryable until the previous socket retires", async () => {
    const fixture = await setup();
    const grant = await fixture.pair();
    const previous = await fixture.activate(grant);
    const stop = new AbortController();
    const ready = vi.fn(() => stop.abort());
    const options = {
      url: fixture.base.replace("http:", "ws:"),
      authorization: grant.credential,
      hostId: grant.hostId,
      identity: testHostIdentity,
      signal: stop.signal,
      onPaired: async () => {
        throw new Error("unexpected_pairing");
      },
      onReady: ready,
    };
    expect(await connectNativeHost(options)).toBe("disconnected");
    expect(ready).not.toHaveBeenCalled();
    expect((await fixture.api()).body.connected).toBe(true);
    previous.terminate();
    await vi.waitFor(async () => {
      expect((await fixture.api()).body.connected).toBe(false);
    });
    expect(await connectNativeHost(options)).toBe("stopped");
    expect(ready).toHaveBeenCalledExactlyOnceWith(grant.hostId);
  });
  it("pairs once, keeps secrets out of status and shares one identity through the installation broker", async () => {
    const fixture = await setup();
    const grant = await fixture.pair();
    const socket = await fixture.activate(grant);
    const status = await fixture.api();
    expect(status.body).toMatchObject({
      paired: true,
      connected: true,
      hostId: grant.hostId,
    });
    expect(await readHostStatus(fixture.rootDir)).toMatchObject({
      hostId: grant.hostId,
      connected: true,
    });
    const state = await readFile(
      join(fixture.rootDir, ".runtime/system-host/pairing.json"),
      "utf8",
    );
    expect(state).not.toContain(grant.code);
    expect(state).not.toContain(grant.credential);
    expect(JSON.stringify(status.body)).not.toContain(grant.credential);
    await expect(fixture.open(grant.code)).rejects.toThrow("401");
    expect((await fixture.api("/pairing", "POST")).status).toBe(409);
    socket.terminate();
  });
  it("rejects browser-origin sockets and foreign-origin configuration writes", async () => {
    const fixture = await setup();
    const grant = await fixture.pair();
    await expect(fixture.open(grant.credential, fixture.base)).rejects.toThrow(
      "401",
    );
    expect(
      (await fixture.api("", "DELETE", "https://attacker.invalid")).status,
    ).toBe(403);
    expect((await fixture.api()).body.paired).toBe(true);
  });
  it("binds action and receipt to the approved host and preserves the evidence limit", async () => {
    const fixture = await setup();
    const grant = await fixture.pair();
    const socket = await fixture.activate(grant);
    const wrong = await executeHostOperation(fixture.rootDir, {
      hostId: randomUUID(),
      connectionId: (await readHostStatus(fixture.rootDir)).connectionId!,
      operation: "system_command",
      params: {},
    });
    expect(wrong).toMatchObject({
      ok: false,
      errorCode: "system_host_unavailable",
    });
    const received = nextHostMessage(socket);
    const result = executeHostOperation(fixture.rootDir, {
      hostId: grant.hostId,
      connectionId: (await readHostStatus(fixture.rootDir)).connectionId!,
      operation: "system_command",
      params: {
        target: "windows",
        command: "Write-Output inspected",
        cwd: "C:\\",
      },
    });
    const operation = await received;
    expect(operation).toMatchObject({
      type: "execute",
      hostId: grant.hostId,
      operation: "system_command",
    });
    socket.send(
      JSON.stringify({
        type: "result",
        id: operation.id,
        result: {
          ok: true,
          output: "command completed",
          producedNewInformation: true,
          data: {
            hostId: "wrong-host",
            independentOutcomeCheck: "not_performed",
            evidenceScope: "command_process_completion",
            spawnedProcess: { pid: 987, pidNamespace: "runtime_os" },
          },
        },
      }),
    );
    const receipt = await result;
    expect(receipt).toMatchObject({
      ok: true,
      data: {
        transport: "host_companion",
        independentOutcomeCheck: "not_performed",
        spawnedProcess: { pidNamespace: "companion_os" },
      },
    });
    expect(receipt.data).not.toHaveProperty("hostId");
    expect(receipt.data).not.toHaveProperty("hostIdentity");
    expect(JSON.stringify(receipt)).not.toContain(grant.hostId);
    socket.terminate();
  });
  it("marks disconnection after dispatch unknown and never replays on reconnection", async () => {
    const fixture = await setup();
    const grant = await fixture.pair();
    const socket = await fixture.activate(grant);
    const incoming = nextHostMessage(socket);
    const result = executeHostOperation(fixture.rootDir, {
      hostId: grant.hostId,
      connectionId: (await readHostStatus(fixture.rootDir)).connectionId!,
      operation: "system_launch",
      params: { target: "windows", application_id: "qa" },
    });
    await incoming;
    socket.terminate();
    const receipt = await result;
    expect(receipt).toMatchObject({
      ok: false,
      errorCode: "system_host_outcome_unknown",
      data: { outcome: "unknown", retrySafe: false },
    });
    expect(JSON.stringify(receipt)).not.toContain(grant.hostId);
    const reconnected = await fixture.activate(grant);
    const messages: unknown[] = [];
    reconnected.on("message", (message) => messages.push(message));
    expect(await readHostStatus(fixture.rootDir)).toMatchObject({
      connected: true,
    });
    expect(messages).toEqual([]);
    reconnected.terminate();
  });
  it("cancels the exact dispatched operation and revokes credentials", async () => {
    const fixture = await setup();
    const grant = await fixture.pair();
    const socket = await fixture.activate(grant);
    const abort = new AbortController();
    const incoming = nextHostMessage(socket);
    const result = executeHostOperation(fixture.rootDir, {
      hostId: grant.hostId,
      connectionId: (await readHostStatus(fixture.rootDir)).connectionId!,
      operation: "system_command",
      params: {},
      abortSignal: abort.signal,
    });
    const operation = await incoming;
    const cancelled = nextHostMessage(socket);
    abort.abort();
    expect(await result).toMatchObject({
      ok: false,
      errorCode: "system_host_outcome_unknown",
    });
    expect(await cancelled).toMatchObject({ type: "cancel", id: operation.id });
    expect((await fixture.api("", "DELETE")).body).toMatchObject({
      ok: true,
      paired: false,
      connected: false,
    });
    await expect(fixture.open(grant.credential)).rejects.toThrow("401");
  });
  it("preserves pairing on ordinary Web restart and reconnects with the same credential", async () => {
    const fixture = await setup();
    const grant = await fixture.pair();
    const socket = await fixture.activate(grant);
    const closed = new Promise<number>((resolve) =>
      socket.once("close", resolve),
    );
    await fixture.restart();
    expect(await closed).toBe(1012);
    const reconnected = await fixture.activate(grant);
    expect((await fixture.api()).body).toMatchObject({
      paired: true,
      connected: true,
      hostId: grant.hostId,
    });
    reconnected.terminate();
  });
  it("does not report no effects after a malformed result interrupts an action", async () => {
    const fixture = await setup();
    const grant = await fixture.pair();
    const socket = await fixture.activate(grant);
    const incoming = nextHostMessage(socket);
    const result = executeHostOperation(fixture.rootDir, {
      hostId: grant.hostId,
      connectionId: (await readHostStatus(fixture.rootDir)).connectionId!,
      operation: "system_command",
      params: {},
    });
    const operation = await incoming;
    socket.send(
      JSON.stringify({
        type: "result",
        id: operation.id,
        result: { ok: true, output: {} },
      }),
    );
    expect(await result).toMatchObject({
      ok: false,
      errorCode: "system_host_outcome_unknown",
      data: { retrySafe: false },
    });
  });
});
