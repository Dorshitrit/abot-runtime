import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HostPairingStore } from "../../computer-access/companion/pairing-store.js";
import { HostSetupRoutes } from "../../web-ui/system-host-setup/routes.js";
import {
  readHostReadiness,
  type HostReadiness,
} from "../../web-ui/system-host-setup/readiness.js";
import { companionReleaseStatus } from "../../computer-access/companion/release-version.js";
import {
  renderCompanionInstaller,
  renderWslInteropInstaller,
} from "../../web-ui/system-host-setup/installers.js";

vi.mock("../../web-ui/system-host-setup/installers.js", () => ({
  renderCompanionInstaller: vi.fn(async () => ({
    filename: "setup.cmd",
    mimeType: "application/octet-stream",
    contentBase64: "Zml4dHVyZQ==",
  })),
  renderWslInteropInstaller: vi.fn(async () => ({
    filename: "wsl.cmd",
    mimeType: "application/octet-stream",
    contentBase64: "Zml4dHVyZQ==",
  })),
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
    ready: false,
    route: "setup_required",
    environment: "container",
    platforms: ["windows", "macos"],
    restartRequired: false,
  }));
  const prepareCompanion = vi.fn(async () => {});
  const routes = new HostSetupRoutes({
    store,
    bundleFile,
    readiness,
    prepareCompanion,
  });
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    void routes
      .handle(
        request,
        response,
        new URL(request.url!, "http://localhost").pathname,
      )
      .catch(() => {
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
  const setup = (
    body: unknown = { platform: "windows" },
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}/web-api/runtime/system-host/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const download = (code?: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/web-api/runtime/system-host/bundle`, {
      headers: {
        ...(code ? { authorization: `Bearer ${code}` } : {}),
        ...headers,
      },
    });
  return {
    base,
    bundle,
    bundleFile,
    store,
    readiness,
    prepareCompanion,
    setup,
    download,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("GUI installation routes", () => {
  test("issues bounded automatic pairing with the exact running bundle hash", async () => {
    const f = await fixture();
    const response = await f.setup();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      filename: "setup.cmd",
      restartRequired: false,
    });
    expect(body.code).toBeUndefined();
    const input = vi.mocked(renderCompanionInstaller).mock.calls[0]![0];
    expect(input.url).toBe(f.base);
    expect(input.upgradeHostId).toBeUndefined();
    expect(input.bundleSha256).toBe(
      createHash("sha256").update(f.bundle).digest("hex"),
    );
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
    const first = vi.mocked(renderCompanionInstaller).mock.calls.at(-1)![0]
      .code;
    expect((await f.download(first, { origin: f.base })).status).toBe(401);
    expect(
      (await f.download(first, { "sec-fetch-site": "same-origin" })).status,
    ).toBe(401);
    await f.setup();
    expect((await f.download(first)).status).toBe(401);
    const current = vi.mocked(renderCompanionInstaller).mock.calls.at(-1)![0]
      .code;
    const grant = f.store.consume(current, {
      name: "fixture",
      os: "windows",
      user: "test",
      homeDir: "C:\\Users\\test",
    });
    expect((await f.download(current)).status).toBe(401);
    expect((await f.download(grant.credential)).status).toBe(401);
  });

  test("rejects cross-site and unsupported inputs before creating or downloading anything", async () => {
    const f = await fixture();
    expect(
      (await f.setup(undefined, { origin: "https://foreign.invalid" })).status,
    ).toBe(403);
    expect(
      (await f.setup(undefined, { "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect(
      (await f.setup({ platform: "windows", url: "http://foreign.invalid" }))
        .status,
    ).toBe(400);
    expect((await f.setup({ platform: "unsupported" })).status).toBe(400);
    expect(f.prepareCompanion).not.toHaveBeenCalled();
    expect(renderCompanionInstaller).not.toHaveBeenCalled();
  });

  test.each(["windows", "macos", "linux"] as const)(
    "legacy learning setup uses the same %s upgrade and preserves the pairing",
    async (platform) => {
      const f = await fixture();
      const pairing = f.store.begin();
      const existing = f.store.consume(pairing.code, {
        name: "fixture",
        os: platform,
        user: "test",
        homeDir: "C:\\Users\\test",
      });
      const host = f.store.host();
      f.readiness.mockResolvedValue({
        ready: false,
        companionUpdateRequired: true,
        environment: "container",
        route: "companion",
        platforms: [platform],
        restartRequired: false,
      });
      expect((await f.setup({ platform: "wrong" })).status).toBe(400);
      expect((await f.setup({ platform, purpose: "learning" })).status).toBe(
        200,
      );
      const installer = vi
        .mocked(renderCompanionInstaller)
        .mock.calls.at(-1)![0];
      const upgrade = installer.code;
      expect(installer.upgradeHostId).toBe(existing.hostId);
      expect(installer.url).toBe(f.base);
      expect(f.store.host()).toEqual(host);
      expect(f.store.authenticate(existing.credential)).toBe("credential");
      expect(f.store.authenticate(upgrade)).toBeUndefined();
      expect(() => f.store.consume(upgrade, host!.identity)).toThrow(
        "host_pairing_expired",
      );
      expect((await f.download(upgrade)).status).toBe(200);
      expect((await f.download(existing.credential)).status).toBe(401);
      expect((await f.download(upgrade, { origin: f.base })).status).toBe(401);
      expect(
        (await f.download(upgrade, { "sec-fetch-site": "same-origin" })).status,
      ).toBe(401);
      f.advance(15 * 60_000);
      expect((await f.download(upgrade)).status).toBe(401);
      expect(f.store.host()).toEqual(host);
    },
  );

  test.each([
    ["container", true],
    ["wsl", true],
    ["native", true],
    ["container", false],
    ["wsl", false],
    ["native", false],
  ] as const)(
    "computer access upgrades a paired companion from %s (connected: %s) without re-pairing or WSL repair",
    async (environment, connected) => {
      const f = await fixture();
      const pairing = f.store.begin();
      const identity = {
        name: "fixture",
        os: "windows" as const,
        user: "owner",
        homeDir: "C:\\Users\\owner",
      };
      const existing = f.store.consume(pairing.code, identity);
      const host = f.store.host();
      f.readiness.mockResolvedValue(
        await readHostReadiness(
          {
            paired: true,
            identity,
            ...(connected
              ? {
                  connected: true as const,
                  connectionId: "fixture-connection",
                  capabilities: ["passive-observations-v1"],
                  companion: companionReleaseStatus(2),
                }
              : { connected: false as const }),
          },
          {
            facts: {
              platform: environment === "native" ? "win32" : "linux",
              kernelRelease: "microsoft-standard-WSL2",
              containerMarker: environment === "container",
            },
          },
        ),
      );
      expect((await f.setup({ platform: "macos" })).status).toBe(409);
      const response = await f.setup();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        restartRequired: false,
        filename: "setup.cmd",
      });
      const installer = vi
        .mocked(renderCompanionInstaller)
        .mock.calls.at(-1)![0];
      const upgrade = installer.code;
      expect(installer.upgradeHostId).toBe(existing.hostId);
      expect(installer.url).toBe(f.base);
      expect(renderWslInteropInstaller).not.toHaveBeenCalled();
      expect(f.store.host()).toEqual(host);
      expect(f.store.authenticate(existing.credential)).toBe("credential");
      expect(f.store.authenticate(upgrade)).toBeUndefined();
      expect(f.store.authenticateBundleUpgrade(upgrade)).toBe(true);
      expect((await f.download(upgrade)).status).toBe(200);
    },
  );

  test("replacement and host revocation invalidate download-only upgrade grants", async () => {
    const f = await fixture();
    const pairing = f.store.begin();
    const identity = {
      name: "fixture",
      os: "windows" as const,
      user: "test",
      homeDir: "C:\\Users\\test",
    };
    f.store.consume(pairing.code, identity);
    const first = f.store.beginBundleUpgrade();
    const current = f.store.beginBundleUpgrade();
    expect((await f.download(first.code)).status).toBe(401);
    expect((await f.download(current.code)).status).toBe(200);
    f.store.revoke();
    expect((await f.download(current.code)).status).toBe(401);
    const replacement = f.store.begin();
    f.store.consume(replacement.code, identity);
    expect((await f.download(current.code)).status).toBe(401);
  });

  test("no setup grant is issued when the shared connection is already ready", async () => {
    const f = await fixture();
    f.readiness.mockResolvedValue({
      ready: true,
      environment: "native",
      route: "native",
      platforms: [],
      restartRequired: false,
    });
    expect((await f.setup()).status).toBe(409);
    expect(f.prepareCompanion).not.toHaveBeenCalled();
    expect(renderCompanionInstaller).not.toHaveBeenCalled();
  });

  test.each(["windows", "macos", "linux"] as const)(
    "direct %s access uses the shared installer, including legacy learning clients",
    async (platform) => {
      const f = await fixture();
      f.readiness.mockResolvedValue({
        ready: false,
        directAccessReady: true,
        environment: "native",
        route: "setup_required",
        platforms: [platform],
        restartRequired: false,
      });
      const response = await f.setup({ platform, purpose: "learning" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ restartRequired: false });
      expect(f.prepareCompanion).toHaveBeenCalledOnce();
      expect(renderCompanionInstaller).toHaveBeenCalledWith(
        expect.objectContaining({ platform }),
      );
      expect(renderWslInteropInstaller).not.toHaveBeenCalled();
    },
  );

  test("learning on WSL requests a companion without changing interop or restarting the distribution", async () => {
    const f = await fixture();
    f.readiness.mockResolvedValue({
      ready: false,
      environment: "wsl",
      route: "setup_required",
      platforms: ["windows"],
      restartRequired: true,
      distribution: "Ubuntu-fixture",
    });
    const response = await f.setup({
      platform: "windows",
      purpose: "learning",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ restartRequired: false });
    expect(renderCompanionInstaller).toHaveBeenCalledOnce();
    expect(renderWslInteropInstaller).not.toHaveBeenCalled();
  });

  test("learning setup retains same-origin validation and rejects unknown purposes", async () => {
    const f = await fixture();
    expect(
      (
        await f.setup(
          { platform: "linux", purpose: "learning" },
          { origin: "https://foreign.invalid" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await f.setup({ platform: "windows", purpose: "other" })).status,
    ).toBe(400);
    expect(renderCompanionInstaller).not.toHaveBeenCalled();
  });

  test("Computer access on WSL pairs one companion without interop repair or restart", async () => {
    const f = await fixture();
    f.readiness.mockResolvedValue({
      ready: false,
      environment: "wsl",
      route: "setup_required",
      platforms: ["windows"],
      restartRequired: true,
      distribution: "Ubuntu-fixture",
    });
    const response = await f.setup();
    expect(await response.json()).toMatchObject({
      restartRequired: false,
      filename: "setup.cmd",
    });
    expect(renderWslInteropInstaller).not.toHaveBeenCalled();
    expect(f.prepareCompanion).toHaveBeenCalledOnce();
    expect(renderCompanionInstaller).toHaveBeenCalledOnce();
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
