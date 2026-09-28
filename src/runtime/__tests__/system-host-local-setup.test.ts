import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, request as requestHttp, type IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HostPairingStore } from "../../computer-access/companion/pairing-store.js";
import { resolveNativeRuntimeAddress } from "../../computer-access/companion/native-address.js";
import { LocalCompanionSetupError } from "../../computer-access/companion/local-installation.js";
import { LocalHostConnection, LOCAL_HOST_SETUP_PATH } from "../../web-ui/system-host-setup/local-connection.js";
import { canSetUpLocalMac, localMacSetupRuntimeUrl, withLocalMacSetup } from "../../web-ui/system-host-setup/local-setup-availability.js";
import type { HostReadiness } from "../../web-ui/system-host-setup/readiness.js";

const readiness: HostReadiness = { ready: false, environment: "native", route: "setup_required",
  platforms: ["macos"], restartRequired: false };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

function localRequest(changes: { host?: string; remote?: string; local?: string; port?: number } = {}) {
  const host = changes.host ?? "localhost:5177";
  return { headers: { host }, rawHeaders: ["Host", host],
    socket: { remoteAddress: changes.remote ?? "127.0.0.1", localAddress: changes.local ?? "127.0.0.1",
      localPort: changes.port ?? 5177 } } as IncomingMessage;
}

describe("native Mac setup eligibility", () => {
  test("requires the native Mac and the exact loopback listener, not browser platform hints", () => {
    expect(canSetUpLocalMac(localRequest(), readiness, "darwin")).toBe(true);
    expect(canSetUpLocalMac(localRequest(), readiness, "linux")).toBe(false);
    expect(canSetUpLocalMac(localRequest(), { ...readiness, environment: "container" }, "darwin")).toBe(false);
    expect(canSetUpLocalMac(localRequest(), { ...readiness, ready: true }, "darwin")).toBe(false);
    expect(canSetUpLocalMac(localRequest(), { ...readiness, platforms: ["windows"] }, "darwin")).toBe(false);
    for (const changes of [{ remote: "192.168.1.2" }, { local: "192.168.1.3" },
      { host: "foreign.invalid:5177" }, { host: "localhost:9999" }, { host: "localhost:5177@foreign.invalid" }])
      expect(canSetUpLocalMac(localRequest(changes), readiness, "darwin")).toBe(false);
  });

  test("supports IPv6 loopback and retains the established hostname authority", () => {
    expect(canSetUpLocalMac(localRequest({ host: "[::1]:5177", local: "::1", remote: "::1" }), readiness, "darwin")).toBe(true);
    expect(canSetUpLocalMac(localRequest({ host: "abot.localhost:5177" }), readiness, "darwin")).toBe(true);
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    expect(withLocalMacSetup(localRequest(), readiness)).toMatchObject({ localSetupAvailable: true,
      localComputerName: expect.any(String) });
    expect(withLocalMacSetup(localRequest({ remote: "192.168.1.2" }), readiness)).toMatchObject({ localSetupAvailable: false });
  });

  test("keeps the HTTPS hostname for certificate verification on an IPv6 listener", async () => {
    const request = localRequest({ local: "::1", remote: "::1" });
    Object.assign(request.socket, { encrypted: true });
    expect(canSetUpLocalMac(request, readiness, "darwin")).toBe(true);
    const url = localMacSetupRuntimeUrl(request);
    expect(url).toBe("https://localhost:5177");
    expect(await resolveNativeRuntimeAddress(url)).toMatchObject({
      url: "wss://localhost:5177/system-host/connect",
      addresses: [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }],
    });
  });
});

async function fixture(listenerAddress = "127.0.0.1") {
  const parent = join(process.cwd(), ".codex/artifacts/macos-local-connect-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "routes-"));
  const store = new HostPairingStore(directory);
  const bundle = vi.fn(async () => Buffer.from("installed companion bytes"));
  const prepareCompanion = vi.fn(async () => {});
  const install = vi.fn(async (_input: { bundle: Buffer; url: string; code: string; upgradeHostId?: string }) => {});
  const readReadiness = vi.fn(async () => readiness);
  const local = new LocalHostConnection({ store, bundle, prepareCompanion, readiness: readReadiness, install });
  const server = createServer((request, response) => {
    void local.handle(request, response).catch(() => { response.writeHead(503); response.end(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: listenerAddress, ipv6Only: true }, resolve);
  });
  const port = (server.address() as { port: number }).port;
  const listenerHost = listenerAddress === "::1" ? "[::1]" : listenerAddress;
  const base = `http://${listenerHost}:${port}`;
  cleanups.push(async () => {
    await local.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const connect = (body: unknown = {}, headers: Record<string, string> = {}) => fetch(base + LOCAL_HOST_SETUP_PATH, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  return { base, port, store, bundle, prepareCompanion, install, local, readReadiness, connect };
}

describe("local Mac connection route", () => {
  test.each(["127.0.0.1", "::1"])("localhost setup reaches its validated %s listener", async (listenerAddress) => {
    const f = await fixture(listenerAddress);
    const authority = `localhost:${f.port}`;
    f.install.mockImplementationOnce(async ({ url }) => {
      const resolved = await resolveNativeRuntimeAddress(url);
      expect(resolved.addresses).toHaveLength(1);
      const address = resolved.addresses[0]!;
      expect(address.address).toBe(listenerAddress);
      const socket = createConnection({
        host: address.address, family: address.family, port: f.port,
      });
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("error", reject);
        });
      } finally {
        socket.destroy();
      }
    });
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = requestHttp(f.base + LOCAL_HOST_SETUP_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", host: authority, origin: `http://${authority}` },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      outgoing.once("error", reject);
      outgoing.end("{}");
    });
    expect(status).toBe(200);
    expect(f.install).toHaveBeenCalledOnce();
    expect(f.install.mock.calls[0]![0].url).toBe(f.base);
  });

  test("passes a private short-lived grant and the installed bundle to existing setup, returning no secret", async () => {
    const f = await fixture();
    const response = await f.connect();
    expect(await response.json()).toEqual({ ok: true });
    expect(f.install).toHaveBeenCalledOnce();
    const input = f.install.mock.calls[0]![0];
    expect(input).toEqual({ bundle: Buffer.from("installed companion bytes"), url: f.base, code: expect.any(String) });
    expect(f.store.authenticate(input.code)).toBe("pairing");
    expect(f.prepareCompanion).toHaveBeenCalledOnce();
  });

  test("repair uses the existing host identity and preserves its credential", async () => {
    const f = await fixture();
    const existing = f.store.consume(f.store.begin().code, { name: "Mac", os: "macos", user: "test", homeDir: "/Users/test" });
    expect((await f.connect()).status).toBe(200);
    const input = f.install.mock.calls[0]![0];
    expect(input.upgradeHostId).toBe(existing.hostId);
    expect(f.store.authenticate(input.code)).toBeUndefined();
    expect(f.store.authenticateBundleUpgrade(input.code)).toBe(true);
    expect(f.store.authenticate(existing.credential)).toBe("credential");
  });

  test("denies foreign origins, caller-supplied targets and other runtimes before setup effects", async () => {
    const f = await fixture();
    expect((await f.connect({}, { origin: "https://foreign.invalid" })).status).toBe(403);
    expect((await f.connect({}, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await f.connect({ url: "http://elsewhere.invalid", platform: "darwin" })).status).toBe(400);
    vi.stubGlobal("process", { ...process, platform: "linux" });
    expect((await f.connect()).status).toBe(409);
    expect(f.prepareCompanion).not.toHaveBeenCalled();
    expect(f.bundle).not.toHaveBeenCalled();
    expect(f.install).not.toHaveBeenCalled();
  });

  test("serializes setup, retains one grant, and waits for setup at shutdown", async () => {
    const f = await fixture();
    let finish!: () => void;
    f.install.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = f.connect();
    await vi.waitFor(() => expect(f.install).toHaveBeenCalledOnce());
    const code = f.install.mock.calls[0]![0].code;
    expect((await f.connect()).status).toBe(409);
    expect(f.store.authenticate(code)).toBe("pairing");
    let closed = false;
    const closing = f.local.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    expect((await first).status).toBe(200);
    await closing;
    expect(f.local.busy).toBe(false);
  });

  test("missing installed bundle does not create a grant or start a process", async () => {
    const f = await fixture();
    const begin = vi.spyOn(f.store, "begin");
    f.bundle.mockRejectedValueOnce(new Error("missing bundle"));
    expect((await f.connect()).status).toBe(503);
    expect(begin).not.toHaveBeenCalled();
    expect(f.prepareCompanion).not.toHaveBeenCalled();
    expect(f.install).not.toHaveBeenCalled();
  });

  test("returns a safe setup failure and releases the operation for a later explicit retry", async () => {
    const f = await fixture();
    f.install.mockRejectedValueOnce(new LocalCompanionSetupError("host_local_setup_timeout"));
    const response = await f.connect();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: "host_local_setup_timeout", message: expect.any(String) });
    expect(f.local.busy).toBe(false);
    expect((await f.connect()).status).toBe(200);
  });
});
