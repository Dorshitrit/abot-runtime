import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import type { HostIdentity } from "../../computer-access/companion/protocol.js";
import { MACOS_PERMISSION_CAPABILITY } from "../../computer-access/companion/permission-protocol.js";
import { hostCompanionFixture, nextHostMessage } from "./support/host-companion-fixture.js";

const macIdentity: HostIdentity = { name: "Test Mac", os: "macos", user: "tester", homeDir: "/Users/tester" };
const permissionData = {
  permissions: { screenRecording: "granted", accessibility: "required" },
  executablePath: "/fixture/host-companion/runtime/node",
  restartMayBeRequired: false,
};

async function connectedMac(capabilities = [MACOS_PERMISSION_CAPABILITY]) {
  const fixture = await hostCompanionFixture();
  const pairing = await fixture.api("/pairing", "POST");
  const pairingSocket = await fixture.open(String(pairing.body.code));
  const receipt = nextHostMessage(pairingSocket);
  pairingSocket.send(JSON.stringify({ type: "hello", version: 1, identity: macIdentity }));
  const grant = await receipt;
  pairingSocket.terminate();
  const client = await fixture.open(String(grant.credential));
  const ready = nextHostMessage(client);
  client.send(JSON.stringify({ type: "hello", version: 1, identity: macIdentity, hostId: grant.hostId, capabilities }));
  await ready;
  const status = (await fixture.api()).body;
  const binding = { hostId: status.hostId, connectionId: status.connectionId };
  const calls: Record<string, unknown>[] = [];
  let reply = (message: Record<string, unknown>) => {
    client.send(JSON.stringify({ type: "result", id: message.id,
      result: { ok: true, output: "Permission state.", producedNewInformation: true, data: permissionData } }));
  };
  client.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString()) as Record<string, unknown>;
    if (message.type !== "execute") return;
    calls.push(message);
    reply(message);
  });
  return {
    ...fixture, binding, client, calls,
    setReply(handler: typeof reply) { reply = handler; },
    request(body: unknown = { ...binding, action: "check" }, headers: Record<string, string> = {}) {
      return fetch(fixture.base + "/web-api/runtime/system-host/permissions", {
        method: "POST", headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    },
  };
}

test("permission control uses the bound Mac channel and returns only its permission subject", async () => {
  const fixture = await connectedMac();
  try {
    const response = await fixture.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, scope: "companion", ...fixture.binding, ...permissionData });
    expect(fixture.calls).toEqual([expect.objectContaining({
      operation: "macos_permissions", hostId: fixture.binding.hostId,
      params: { target: "macos", action: "check" },
    })]);
    const requested = await fixture.request({ ...fixture.binding, action: "request", permission: "accessibility" });
    expect(requested.status).toBe(200);
    expect(fixture.calls[1]).toMatchObject({ params: { target: "macos", action: "request", permission: "accessibility" } });
  } finally { await fixture.close(); }
});

test("origin, content type, bounded payload and permission allowlist reject before dispatch", async () => {
  const fixture = await connectedMac();
  try {
    expect((await fixture.request(undefined, { origin: "https://untrusted.example" })).status).toBe(403);
    expect((await fixture.request(undefined, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await fixture.request(undefined, { "content-type": "text/plain" })).status).toBe(415);
    for (const action of [
      { action: "check", permission: "accessibility" },
      { action: "request" }, { action: "request", permission: "everything" },
      { action: "check", command: "unused" }, { action: "check", target: "macos" },
      { action: "check", excess: "x".repeat(1024) },
    ]) expect((await fixture.request({ ...fixture.binding, ...action })).status).toBe(400);
    const get = await fetch(fixture.base + "/web-api/runtime/system-host/permissions");
    expect(get.status).toBe(405);
    expect(fixture.calls).toEqual([]);
  } finally { await fixture.close(); }
});

test("stale host and connection identities never dispatch or fall back to native execution", async () => {
  const fixture = await connectedMac();
  try {
    expect((await fixture.request({ ...fixture.binding, hostId: randomUUID(), action: "check" })).status).toBe(409);
    expect((await fixture.request({ ...fixture.binding, connectionId: randomUUID(), action: "check" })).status).toBe(409);
    expect(fixture.calls).toEqual([]);
  } finally { await fixture.close(); }
});

test("older companions fail closed with an update request", async () => {
  const fixture = await connectedMac([]);
  try {
    const response = await fixture.request();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "macos_permissions_update_required" });
    expect(fixture.calls).toEqual([]);
  } finally { await fixture.close(); }
});

test("a disconnected permission owner invalidates the result rather than claiming ready", async () => {
  const fixture = await connectedMac();
  try {
    fixture.setReply(() => fixture.client.terminate());
    const response = await fixture.request();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "macos_permissions_host_changed" });
  } finally { await fixture.close(); }
});

test("permission requests are serialized and helper diagnostics cannot escape to UI", async () => {
  const fixture = await connectedMac();
  try {
    fixture.setReply(() => {});
    const pending = fixture.request({ ...fixture.binding, action: "request", permission: "screen_recording" });
    await vi.waitFor(() => expect(fixture.calls).toHaveLength(1));
    expect((await fixture.request()).status).toBe(409);
    fixture.client.send(JSON.stringify({ type: "result", id: fixture.calls[0]!.id,
      result: { ok: false, output: "/private/secret compiler stderr", producedNewInformation: false } }));
    const response = await pending;
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("/private/secret");
  } finally { await fixture.close(); }
});
