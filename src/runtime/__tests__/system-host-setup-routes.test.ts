import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HostPairingStore } from "../../../plugins/system/source/companion/pairing-store.js";
import { HostSetupRoutes } from "../../web-ui/system-host-setup/routes.js";
import type { HostReadiness } from "../../web-ui/system-host-setup/readiness.js";
import { renderCompanionInstaller, renderWslInteropInstaller } from "../../web-ui/system-host-setup/installers.js";

vi.mock("../../web-ui/system-host-setup/installers.js", () => ({
  renderCompanionInstaller: vi.fn(async () => ({ filename: "setup.cmd", mimeType: "application/octet-stream", contentBase64: "Zml4dHVyZQ==" })),
  renderWslInteropInstaller: vi.fn(async () => ({ filename: "wsl.cmd", mimeType: "application/octet-stream", contentBase64: "Zml4dHVyZQ==" })),
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.clearAllMocks();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abot-setup-routes-"));
  let now = Date.now();
  const store = new HostPairingStore(root, () => now);
  const bundleFile = join(root, "companion.mjs");
  const bundle = "console.log('fixture companion');";
  await writeFile(bundleFile, bundle);
  const readiness = vi.fn<() => Promise<HostReadiness>>(async () => ({
    ready: false, route: "setup_required", environment: "container",
    platforms: ["windows", "macos"], restartRequired: false,
  }));
  const prepareCompanion = vi.fn(async () => {});
  const routes = new HostSetupRoutes({ store, bundleFile, readiness, prepareCompanion });
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    void routes.handle(request, response, new URL(request.url!, "http://localhost").pathname)
      .catch(() => { response.writeHead(503); response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const setup = (body: unknown = { platform: "windows" }, headers: Record<string, string> = {}) => fetch(`${base}/web-api/runtime/system-host/setup`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const download = (code?: string, headers: Record<string, string> = {}) => fetch(`${base}/web-api/runtime/system-host/bundle`, {
    headers: { ...(code ? { authorization: `Bearer ${code}` } : {}), ...headers },
  });
  return { base, bundle, bundleFile, store, readiness, prepareCompanion, setup, download, advance: (ms: number) => { now += ms; } };
}

describe("GUI installation routes", () => {
  test("issues bounded automatic pairing with the exact running bundle hash", async () => {
    const f = await fixture();
    const response = await f.setup();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ filename: "setup.cmd", restartRequired: false });
    expect(body.code).toBeUndefined();
    const input = vi.mocked(renderCompanionInstaller).mock.calls[0]![0];
    expect(input.url).toBe(f.base);
    expect(input.bundleSha256).toBe(createHash("sha256").update(f.bundle).digest("hex"));
    expect(f.store.authenticate(input.code)).toBe("pairing");
    const download = await f.download(input.code);
    expect(download.status).toBe(200);
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(await download.text()).toBe(f.bundle);
    f.advance(15 * 60_000);
    expect((await f.download(input.code)).status).toBe(401);
  });

  test("requires native bearer authorization and invalidates consumed or replaced grants", async () => {
    const f = await fixture();
    expect((await f.download()).status).toBe(401);
    await f.setup();
    const first = vi.mocked(renderCompanionInstaller).mock.calls.at(-1)![0].code;
    expect((await f.download(first, { origin: f.base })).status).toBe(401);
    expect((await f.download(first, { "sec-fetch-site": "same-origin" })).status).toBe(401);
    await f.setup();
    expect((await f.download(first)).status).toBe(401);
    const current = vi.mocked(renderCompanionInstaller).mock.calls.at(-1)![0].code;
    const grant = f.store.consume(current, { name: "fixture", os: "windows", user: "test", homeDir: "C:\\Users\\test" });
    expect((await f.download(current)).status).toBe(401);
    expect((await f.download(grant.credential)).status).toBe(401);
  });

  test("rejects cross-site and unsupported inputs before creating or downloading anything", async () => {
    const f = await fixture();
    expect((await f.setup(undefined, { origin: "https://foreign.invalid" })).status).toBe(403);
    expect((await f.setup(undefined, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await f.setup({ platform: "windows", url: "http://foreign.invalid" })).status).toBe(400);
    expect((await f.setup({ platform: "linux" })).status).toBe(400);
    expect(f.prepareCompanion).not.toHaveBeenCalled();
    expect(renderCompanionInstaller).not.toHaveBeenCalled();
  });

  test("working native access never issues a companion installer", async () => {
    const f = await fixture();
    f.readiness.mockResolvedValue({ ready: true, environment: "native", route: "native", platforms: [], restartRequired: false });
    expect((await f.setup()).status).toBe(409);
    expect(f.prepareCompanion).not.toHaveBeenCalled();
    expect(renderCompanionInstaller).not.toHaveBeenCalled();
  });

  test("WSL repair targets the observed distribution without pairing or broker startup", async () => {
    const f = await fixture();
    f.readiness.mockResolvedValue({ ready: false, environment: "wsl", route: "setup_required", platforms: ["windows"], restartRequired: true, distribution: "Ubuntu-fixture" });
    const response = await f.setup();
    expect(await response.json()).toMatchObject({ restartRequired: true, filename: "wsl.cmd" });
    expect(renderWslInteropInstaller).toHaveBeenCalledExactlyOnceWith({ distribution: "Ubuntu-fixture" });
    expect(f.prepareCompanion).not.toHaveBeenCalled();
    expect(renderCompanionInstaller).not.toHaveBeenCalled();
    expect((await f.setup({ platform: "macos" })).status).toBe(409);
  });

  test("missing packaged companion cannot create a usable pairing grant", async () => {
    const f = await fixture();
    await rm(f.bundleFile);
    expect((await f.setup()).status).toBe(503);
    expect(f.prepareCompanion).not.toHaveBeenCalled();
    expect(renderCompanionInstaller).not.toHaveBeenCalled();
  });
});
