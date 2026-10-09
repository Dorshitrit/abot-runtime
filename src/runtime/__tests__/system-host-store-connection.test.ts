import {
  createServer,
  request as requestHttp,
} from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { HostPairingStore } from "../../computer-access/companion/pairing-store.js";
import { parseStoreConnectionLink } from "../../computer-access/companion/windows-store/connection-link.js";
import { WINDOWS_COMPANION_STORE_URL } from "../../computer-access/companion/windows-store/identity.js";
import { WINDOWS_STORE_CONNECTION_PATH } from "../../web-ui/system-host-setup/windows-store-route.js";
import { HostSetupRoutes } from "../../web-ui/system-host-setup/routes.js";
import { LOCAL_HOST_SETUP_PATH } from "../../web-ui/system-host-setup/local-connection.js";
import { installLocalMacCompanion } from "../../computer-access/companion/local-installation.js";
import type { HostReadiness } from "../../web-ui/system-host-setup/readiness.js";

vi.mock("../../computer-access/companion/local-installation.js", async (original) => ({
  ...await original<typeof import("../../computer-access/companion/local-installation.js")>(),
  installLocalMacCompanion: vi.fn(async () => {}),
}));
vi.mock("../../web-ui/system-host-setup/installers.js", async (original) => ({
  ...await original<typeof import("../../web-ui/system-host-setup/installers.js")>(),
  renderCompanionInstaller: vi.fn(async () => ({ filename: "setup.command", mimeType: "text/plain", contentBase64: "Zml4dHVyZQ==" })),
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abot-store-connection-"));
  const store = new HostPairingStore(root);
  const begin = vi.spyOn(store, "begin");
  const upgrade = vi.spyOn(store, "beginBundleUpgrade");
  const readiness = vi.fn<() => Promise<HostReadiness>>(async () => ({
    ready: false,
    route: "setup_required",
    environment: "container",
    platforms: ["windows", "macos", "linux"],
    restartRequired: false,
  }));
  const prepareCompanion = vi.fn(async () => {});
  const bundleFile = join(root, "companion.mjs");
  await writeFile(bundleFile, "fixture companion bytes");
  const routes = new HostSetupRoutes({ store, readiness, prepareCompanion, bundleFile });
  const server = createServer((request, response) => {
    const pathname = new URL(request.url!, "http://localhost").pathname;
    if (pathname === "/mutation-guard-probe") {
      if (routes.rejectConcurrentMutation(response)) return;
      response.writeHead(200);
      response.end();
      return;
    }
    void routes.handle(request, response, pathname).catch(() => {
      response.writeHead(503);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });
  const requestAt = (path: string, body = "{}", headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  const request = (body = "{}", headers: Record<string, string> = {}) =>
    requestAt(WINDOWS_STORE_CONNECTION_PATH, body, headers);
  const requestWithHost = (host: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = requestHttp(
        base + WINDOWS_STORE_CONNECTION_PATH,
        {
          method: "POST",
          headers: { host, "content-type": "application/json" },
        },
        (incoming) => {
          let body = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk: string) => {
            body += chunk;
          });
          incoming.on("end", () =>
            resolve({ status: incoming.statusCode!, body }),
          );
          incoming.on("error", reject);
        },
      );
      outgoing.on("error", reject);
      outgoing.end("{}");
    });
  return {
    requestWithHost,
    base,
    request,
    store,
    begin,
    upgrade,
    readiness,
    prepareCompanion,
    requestAt,
    routes,
  };
}

test("same-origin JSON receives an expiring launch invitation without a download", async () => {
  const f = await fixture();
  const started = Date.now();
  const response = await f.request("{}", {
    origin: f.base,
    "sec-fetch-site": "same-origin",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body).toMatchObject({
    ok: true,
    storeUrl: WINDOWS_COMPANION_STORE_URL,
  });
  expect(body.contentBase64).toBeUndefined();
  const invitation = parseStoreConnectionLink(body.launchUrl);
  expect(invitation.url).toBe(f.base);
  expect(invitation.upgradeHostId).toBeUndefined();
  expect(f.store.authenticate(invitation.code)).toBe("pairing");
  expect(Date.parse(invitation.expiresAt)).toBeGreaterThanOrEqual(
    started + 15 * 60_000,
  );
  expect(f.begin).toHaveBeenCalledWith(15 * 60_000);
  expect(f.prepareCompanion).toHaveBeenCalledOnce();
});

test("repair invitations select the existing host and leave its authentication credential valid", async () => {
  const f = await fixture();
  const grant = f.store.begin();
  const previous = f.store.consume(grant.code, {
    name: "fixture",
    os: "windows",
    user: "test",
    homeDir: "C:\\Users\\test",
  });
  const existing = f.store.host();
  f.begin.mockClear();
  const response = await f.request();
  const body = await response.json();
  const invitation = parseStoreConnectionLink(body.launchUrl);
  expect(response.status).toBe(200);
  expect(invitation.upgradeHostId).toBe(previous.hostId);
  expect(f.store.host()).toEqual(existing);
  expect(f.store.authenticate(previous.credential)).toBe("credential");
  expect(f.store.authenticate(invitation.code)).toBeUndefined();
  expect(f.store.authenticateBundleUpgrade(invitation.code)).toBe(true);
  expect(f.begin).not.toHaveBeenCalled();
  expect(f.upgrade).toHaveBeenCalledOnce();
});

test.each([
  [{ origin: "https://foreign.invalid" }, 403],
  [{ "sec-fetch-site": "cross-site" }, 403],
  [{ "content-type": "text/plain" }, 415],
] as const)(
  "rejects unsupported browser mutation headers %j before creating a grant",
  async (headers, status) => {
    const f = await fixture();
    const response = await f.request("{}", headers);
    expect(response.status).toBe(status);
    expect(f.begin).not.toHaveBeenCalled();
    expect(f.upgrade).not.toHaveBeenCalled();
    expect(f.prepareCompanion).not.toHaveBeenCalled();
  },
);

test.each([
  "null",
  "[]",
  "not-json",
  '{"platform":"windows"}',
  '{"code":"private"}',
])("rejects non-empty or invalid connection body %s", async (body) => {
  const f = await fixture();
  expect((await f.request(body)).status).toBe(400);
  expect(f.prepareCompanion).not.toHaveBeenCalled();
  expect(f.begin).not.toHaveBeenCalled();
});

test("GET cannot create an invitation", async () => {
  const f = await fixture();
  expect((await fetch(f.base + WINDOWS_STORE_CONNECTION_PATH)).status).toBe(
    405,
  );
  expect(f.begin).not.toHaveBeenCalled();
});

test.each(["example.invalid", "[broken", "192.168.1.2:5177"])(
  "unsupported Host %s preserves a pending grant and cannot prepare the companion",
  async (host) => {
    const f = await fixture();
    const pending = f.store.begin();
    f.begin.mockClear();
    const response = await f.requestWithHost(host);
    expect(response.status).toBe(400);
    expect(response.body).not.toContain(pending.code);
    expect(f.store.authenticate(pending.code)).toBe("pairing");
    expect(f.prepareCompanion).not.toHaveBeenCalled();
    expect(f.begin).not.toHaveBeenCalled();
  },
);

test.each([
  { platforms: ["linux", "macos"] as const },
  { route: "wsl_interop" as const, environment: "wsl" as const },
  { route: "native" as const },
  { restartRequired: true },
])("does not take over unsupported existing routes %j", async (change) => {
  const f = await fixture();
  const base = await f.readiness();
  f.readiness.mockResolvedValue({ ...base, ...change });
  expect((await f.request()).status).toBe(409);
  expect(f.prepareCompanion).not.toHaveBeenCalled();
  expect(f.begin).not.toHaveBeenCalled();
});

test.each([false, true])("overlapping Store requests retain one valid grant (upgrade=%s)", async (upgrading) => {
  const f = await fixture();
  if (upgrading) {
    f.store.consume(f.store.begin().code, { name: "fixture", os: "windows", user: "test", homeDir: "C:\\Users\\test" });
    f.begin.mockClear();
  }
  let finish!: () => void;
  f.prepareCompanion.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const first = f.request();
  try {
    await vi.waitFor(() => expect(f.prepareCompanion).toHaveBeenCalledOnce());
    const second = await f.request();
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "host_setup_in_progress" });
    expect(f.begin).not.toHaveBeenCalled();
    expect(f.upgrade).not.toHaveBeenCalled();
    expect((await f.requestAt("/mutation-guard-probe")).status).toBe(409);
  } finally { finish(); }
  const accepted = await first;
  expect(accepted.status).toBe(200);
  const invitation = parseStoreConnectionLink((await accepted.json()).launchUrl);
  expect(f.store.authenticate(invitation.code)).toBe(upgrading ? undefined : "pairing");
  expect(f.store.authenticateBundleUpgrade(invitation.code)).toBe(upgrading);
  expect(upgrading ? f.upgrade : f.begin).toHaveBeenCalledOnce();
  expect((await f.requestAt("/mutation-guard-probe")).status).toBe(200);
});

test.each([WINDOWS_STORE_CONNECTION_PATH, LOCAL_HOST_SETUP_PATH])(
  "%s blocks the other setup route while preparation is pending", async (firstPath) => {
    const f = await fixture();
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    f.readiness.mockResolvedValue({ ready: false, route: "setup_required", environment: "native",
      platforms: ["windows", "macos"], restartRequired: false });
    let finish!: () => void;
    f.prepareCompanion.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = f.requestAt(firstPath);
    const secondPath = firstPath === WINDOWS_STORE_CONNECTION_PATH ? LOCAL_HOST_SETUP_PATH : WINDOWS_STORE_CONNECTION_PATH;
    try {
      await vi.waitFor(() => expect(f.prepareCompanion).toHaveBeenCalledOnce());
      expect((await f.requestAt(secondPath)).status).toBe(409);
      expect(f.begin).not.toHaveBeenCalled();
      expect(installLocalMacCompanion).not.toHaveBeenCalled();
    } finally { finish(); }
    expect((await first).status).toBe(200);
    expect(f.begin).toHaveBeenCalledOnce();
    expect(installLocalMacCompanion).toHaveBeenCalledTimes(firstPath === LOCAL_HOST_SETUP_PATH ? 1 : 0);
  },
);

test("failed preparation leaves the existing pending invitation usable", async () => {
  const f = await fixture();
  const pending = f.store.begin();
  f.begin.mockClear();
  f.prepareCompanion.mockRejectedValueOnce(new Error("prepare failed"));
  expect((await f.request()).status).toBe(503);
  expect(f.store.authenticate(pending.code)).toBe("pairing");
  expect(f.begin).not.toHaveBeenCalled();
  expect((await f.requestAt("/mutation-guard-probe")).status).toBe(200);
  expect((await f.request()).status).toBe(200);
  expect(f.begin).toHaveBeenCalledOnce();
});

test.each([WINDOWS_STORE_CONNECTION_PATH, "/web-api/runtime/system-host/setup"])(
  "%s shares its pending mutation with the macOS download route", async (firstPath) => {
    const f = await fixture();
    const downloadPath = "/web-api/runtime/system-host/setup";
    const request = (path: string) => f.requestAt(path, path === downloadPath ? '{"platform":"macos"}' : "{}");
    let finish!: () => void;
    f.prepareCompanion.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = request(firstPath);
    const secondPath = firstPath === WINDOWS_STORE_CONNECTION_PATH ? downloadPath : WINDOWS_STORE_CONNECTION_PATH;
    try {
      await vi.waitFor(() => expect(f.prepareCompanion).toHaveBeenCalledOnce());
      expect((await request(secondPath)).status).toBe(409);
      expect(f.begin).not.toHaveBeenCalled();
    } finally { finish(); }
    expect((await first).status).toBe(200);
    expect(f.begin).toHaveBeenCalledOnce();
    expect(f.store.authenticate(f.begin.mock.results[0]!.value.code)).toBe("pairing");
  },
);
