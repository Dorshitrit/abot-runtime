import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { HostPairingStore } from "../../computer-access/companion/pairing-store.js";
import { parseStoreConnectionLink } from "../../computer-access/companion/windows-store/connection-link.js";
import { WINDOWS_COMPANION_STORE_URL } from "../../computer-access/companion/windows-store/identity.js";
import { HostSetupRoutes } from "../../web-ui/system-host-setup/routes.js";
import { WINDOWS_STORE_CONNECTION_PATH } from "../../web-ui/system-host-setup/windows-store-route.js";
import type { HostReadiness } from "../../web-ui/system-host-setup/readiness.js";

const setupPath = "/web-api/runtime/system-host/setup";
const identity = { name: "existing Windows computer", os: "windows" as const, user: "owner", homeDir: "C:\\Users\\owner" };
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

async function fixture() {
  const fixtures = resolve(".codex/artifacts/windows-store-only-20261009/retirement-fixtures");
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures, "case-"));
  const store = new HostPairingStore(root);
  const begin = vi.spyOn(store, "begin");
  const upgrade = vi.spyOn(store, "beginBundleUpgrade");
  const readiness = vi.fn<() => Promise<HostReadiness>>(async () => ({
    ready: false, route: "setup_required", environment: "wsl",
    platforms: ["windows"], restartRequired: false,
  }));
  const prepareCompanion = vi.fn(async () => {});
  // No bundle exists: retired downloads must not read it, and Store uses its packaged bundle.
  const routes = new HostSetupRoutes({ store, readiness, prepareCompanion, bundleFile: join(root, "missing.mjs") });
  const server = createServer((request, response) => {
    const pathname = new URL(request.url!, "http://localhost").pathname;
    if (pathname === "/mutation-probe") {
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
    await routes.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const request = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { store, begin, upgrade, readiness, prepareCompanion, request };
}

function expectNoSetupEffects(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.readiness).not.toHaveBeenCalled();
  expect(f.prepareCompanion).not.toHaveBeenCalled();
  expect(f.begin).not.toHaveBeenCalled();
  expect(f.upgrade).not.toHaveBeenCalled();
}

test.each([undefined, "learning"])("retired Windows download rejects purpose %s before reading a bundle or preparing a connection", async (purpose) => {
  const f = await fixture();
  const response = await f.request(setupPath, { platform: "windows", ...(purpose ? { purpose } : {}) });
  expect(response.status).toBe(410);
  expect(await response.json()).toEqual({
    ok: false,
    error: "windows_store_required",
    message: "Install or update ABot AI Companion through Microsoft Store.",
    storeUrl: WINDOWS_COMPANION_STORE_URL,
  });
  expectNoSetupEffects(f);
  expect((await f.request("/mutation-probe")).status).toBe(200);
});

test("retired Windows download preserves a pending fresh invitation", async () => {
  const f = await fixture();
  const pending = f.store.begin();
  f.begin.mockClear();
  const response = await f.request(setupPath, { platform: "windows" });
  expect(response.status).toBe(410);
  expect(await response.text()).not.toContain(pending.code);
  expect(f.store.authenticate(pending.code)).toBe("pairing");
  expect(f.store.host()).toBeUndefined();
  expectNoSetupEffects(f);
});

test("retired Windows update preserves an existing peer, credential and pending upgrade invitation", async () => {
  const f = await fixture();
  const previous = f.store.consume(f.store.begin().code, identity);
  const host = f.store.host();
  const pending = f.store.beginBundleUpgrade();
  f.begin.mockClear();
  f.upgrade.mockClear();
  const response = await f.request(setupPath, { platform: "windows", purpose: "learning" });
  expect(response.status).toBe(410);
  expect(await response.text()).not.toContain(pending.code);
  expect(f.store.host()).toEqual(host);
  expect(f.store.authenticate(previous.credential)).toBe("credential");
  expect(f.store.authenticateBundleUpgrade(pending.code)).toBe(true);
  expectNoSetupEffects(f);
});

test.each([
  [{ platform: "windows" }, { origin: "https://foreign.invalid" }, 403],
  [{ platform: "windows" }, { "sec-fetch-site": "cross-site" }, 403],
  [{ platform: "windows" }, { "content-type": "text/plain" }, 415],
  [{ platform: "windows", purpose: "other" }, {}, 400],
  [{ platform: "windows", code: "unexpected" }, {}, 400],
] as const)("retired requests still enforce mutation and input boundaries: %j %j", async (body, headers, status) => {
  const f = await fixture();
  expect((await f.request(setupPath, body, headers)).status).toBe(status);
  expectNoSetupEffects(f);
});

test.each([false, true])("a rejected Windows download cannot interrupt Store pairing or repair (upgrade=%s)", async (upgrading) => {
  const f = await fixture();
  const previous = upgrading ? f.store.consume(f.store.begin().code, identity) : undefined;
  const host = f.store.host();
  f.begin.mockClear();
  let finish!: () => void;
  f.prepareCompanion.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const storeRequest = f.request(WINDOWS_STORE_CONNECTION_PATH);
  try {
    await vi.waitFor(() => expect(f.prepareCompanion).toHaveBeenCalledOnce());
    const rejected = await f.request(setupPath, { platform: "windows" });
    expect(rejected.status).toBe(410);
    expect(f.readiness).toHaveBeenCalledOnce();
    expect(f.begin).not.toHaveBeenCalled();
    expect(f.upgrade).not.toHaveBeenCalled();
    expect((await f.request("/mutation-probe")).status).toBe(409);
  } finally { finish(); }
  const accepted = await storeRequest;
  expect(accepted.status).toBe(200);
  const receipt = await accepted.json();
  expect(receipt.storeUrl).toBe(WINDOWS_COMPANION_STORE_URL);
  expect(receipt.contentBase64).toBeUndefined();
  const invitation = parseStoreConnectionLink(receipt.launchUrl);
  expect(f.store.authenticate(invitation.code)).toBe(upgrading ? undefined : "pairing");
  expect(f.store.authenticateBundleUpgrade(invitation.code)).toBe(upgrading);
  expect(upgrading ? f.upgrade : f.begin).toHaveBeenCalledOnce();
  expect(f.store.host()).toEqual(host);
  if (previous) expect(f.store.authenticate(previous.credential)).toBe("credential");
  expect((await f.request("/mutation-probe")).status).toBe(200);
});
