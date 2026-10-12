import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readCollectionConsent } from "../../computer-access/collection-consent.js";
import { HostPairingStore } from "../../computer-access/companion/pairing-store.js";
import { hostStateDirectory } from "../../computer-access/companion/private-store.js";
import { readRuntimeCollectionSource } from "../../computer-access/observation-source.js";
import { startHostBroker } from "../../computer-access/companion/broker-server.js";
import { WebSystemHostService } from "../../web-ui/system-host-service.js";
import { ensurePrivateRuntimeDirectory } from "../local-host/private-directory.js";

// Keep HTTP/persistence tests independent of PowerShell startup. Real ACLs are
// covered by collection-consent.test.ts and windows-private-access.test.ts.
vi.mock("../local-host/private-directory.js", () => ({
  ensurePrivateRuntimeDirectory: vi.fn(),
}));
vi.mock("../../computer-access/companion/broker-server.js", () => ({
  startHostBroker: vi.fn(async () => { throw new Error("consent_must_not_start_broker"); }),
}));
vi.mock("../../computer-access/observation-source.js", () => ({
  readRuntimeCollectionSource: vi.fn(() => ({ mode: "native", platform: "windows" })),
}));
vi.mock("../../web-ui/system-host-setup/readiness.js", () => ({
  readHostReadiness: vi.fn(async () => ({
    ready: false, route: "setup_required", environment: "native",
    platforms: ["windows"], restartRequired: false, directAccessReady: true,
  })),
}));

const statusPath = "/web-api/runtime/system-host";
const consentPath = statusPath + "/collection-consent";
const roots = new Set<string>();
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.mocked(ensurePrivateRuntimeDirectory).mockReset().mockImplementation(async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  });
  vi.mocked(readRuntimeCollectionSource).mockReturnValue({ mode: "native", platform: "windows" });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
  vi.clearAllMocks();
});

async function fixture(existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), "abot-consent-http-"));
  roots.add(root);
  const service = new WebSystemHostService(root);
  const server = createServer((request, response) => {
    const pathname = new URL(request.url!, "http://localhost").pathname;
    void service.handleHttp(request, response, pathname).then((handled) => {
      if (handled) return;
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
  });
  return {
    root, base,
    status: () => fetch(base + statusPath),
    post: (body = '{"acknowledged":true}', headers: Record<string, string> = {}) =>
      fetch(base + consentPath, {
        method: "POST", body,
        headers: { "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin", ...headers },
      }),
  };
}

async function expectNoConsentWrites(root: string): Promise<void> {
  expect(readCollectionConsent(root)).toEqual({ accepted: false });
  await expect(stat(join(root, ".runtime"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(startHostBroker).not.toHaveBeenCalled();
  expect(ensurePrivateRuntimeDirectory).not.toHaveBeenCalled();
}

test("status exposes consent and collection source without starting or pairing anything", async () => {
  const f = await fixture();
  const response = await f.status();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    ok: true, paired: false, connected: false,
    collectionConsent: { accepted: false },
    collectionSource: { mode: "native", platform: "windows" },
  });
  await expectNoConsentWrites(f.root);
});

test("same-origin acknowledgment persists across fresh services without broker or pairing side effects", async () => {
  const f = await fixture();
  const response = await f.post();
  expect(ensurePrivateRuntimeDirectory).toHaveBeenCalledExactlyOnceWith(hostStateDirectory(f.root));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const accepted = await response.json();
  expect(accepted).toEqual({
    ok: true, collectionConsent: { accepted: true, acceptedAt: expect.any(String) },
  });
  expect(await readdir(hostStateDirectory(f.root))).toEqual(["collection-consent.json"]);
  const originalBytes = await readFile(join(hostStateDirectory(f.root), "collection-consent.json"), "utf8");
  const fresh = await fixture(f.root);
  expect(await (await fresh.status()).json()).toMatchObject({
    paired: false, connected: false, collectionConsent: accepted.collectionConsent,
  });
  expect(await (await fresh.post()).json()).toEqual(accepted);
  expect(await readFile(join(hostStateDirectory(f.root), "collection-consent.json"), "utf8")).toBe(originalBytes);
  expect(startHostBroker).not.toHaveBeenCalled();
}, 30_000);

test("private directory rejection returns unavailable without saving consent or starting a broker", async () => {
  const f = await fixture();
  vi.mocked(ensurePrivateRuntimeDirectory).mockRejectedValueOnce(new Error("local_runtime_directory_not_private"));
  const response = await f.post();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ ok: false, error: "host_connection_unavailable" });
  expect(ensurePrivateRuntimeDirectory).toHaveBeenCalledExactlyOnceWith(hostStateDirectory(f.root));
  expect(readCollectionConsent(f.root)).toEqual({ accepted: false });
  await expect(stat(join(f.root, ".runtime"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(startHostBroker).not.toHaveBeenCalled();
});

test.each(["GET", "PUT", "PATCH", "DELETE", "HEAD"])("%s cannot acknowledge consent", async (method) => {
  const f = await fixture();
  const response = await fetch(f.base + consentPath, { method });
  expect(response.status).toBe(405);
  await expectNoConsentWrites(f.root);
});

test.each([
  "", "not-json", "null", "[]", "true", '"acknowledged"', "{}",
  '{"acknowledged":false}', '{"acknowledged":"true"}',
  '{"acknowledged":true,"extra":true}',
])("invalid acknowledgment %s does not write consent", async (body) => {
  const f = await fixture();
  expect((await f.post(body)).status).toBe(400);
  await expectNoConsentWrites(f.root);
});

test.each([
  [{ origin: "https://foreign.invalid" }, 403],
  [{ "sec-fetch-site": "cross-site" }, 403],
  [{ "content-type": "text/plain" }, 415],
] as const)("mutation header rejection %j does not write consent", async (headers, expected) => {
  const f = await fixture();
  expect((await f.post(undefined, headers)).status).toBe(expected);
  await expectNoConsentWrites(f.root);
});

test("rejected acknowledgment preserves an existing accepted record", async () => {
  const f = await fixture();
  const accepted = await (await f.post()).json();
  const path = join(hostStateDirectory(f.root), "collection-consent.json");
  const original = await readFile(path, "utf8");
  expect((await f.post('{"acknowledged":false}')).status).toBe(400);
  expect((await f.post(undefined, { origin: "https://foreign.invalid" })).status).toBe(403);
  expect(await readFile(path, "utf8")).toBe(original);
  expect(readCollectionConsent(f.root)).toEqual(accepted.collectionConsent);
}, 30_000);

test("pairing and revocation do not change native collection source or accepted consent", async () => {
  const f = await fixture();
  const accepted = await (await f.post()).json();
  const pairing = new HostPairingStore(f.root);
  const grant = pairing.begin();
  pairing.consume(grant.code, { name: "Companion", os: "windows", user: "fixture", homeDir: "C:\\Users\\fixture" });
  expect(await (await f.status()).json()).toMatchObject({
    paired: true, collectionConsent: accepted.collectionConsent,
    collectionSource: { mode: "native", platform: "windows" },
  });
  pairing.revoke();
  expect(await (await f.status()).json()).toMatchObject({
    paired: false, collectionConsent: accepted.collectionConsent,
    collectionSource: { mode: "native", platform: "windows" },
  });
  expect(startHostBroker).not.toHaveBeenCalled();
}, 30_000);

test("status projects the selected Companion source independently of consent", async () => {
  vi.mocked(readRuntimeCollectionSource).mockReturnValue({ mode: "companion", platform: "macos" });
  const f = await fixture();
  expect(await (await f.status()).json()).toMatchObject({
    collectionConsent: { accepted: false },
    collectionSource: { mode: "companion", platform: "macos" },
  });
  await expectNoConsentWrites(f.root);
});
