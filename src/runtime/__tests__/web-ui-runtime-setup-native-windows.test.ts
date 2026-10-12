import { afterEach, expect, test, vi } from "vitest";
import { createGuideHarness, setupSnapshot } from "./support/runtime-setup-guide-harness.js";

const disposers: Array<() => void> = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));

function nativeHost(directAccessReady = true) {
  return {
    paired: false,
    connected: false,
    collectionSource: { mode: "native", platform: "windows" },
    readiness: {
      ready: false,
      route: "setup_required",
      environment: "native",
      platforms: ["windows"],
      directAccessReady,
      restartRequired: false,
    },
  };
}

function harness(snapshot = nativeHost()) {
  const loadHostConnection = vi.fn(async () => snapshot);
  const downloadHostSetup = vi.fn();
  const requestHostStoreConnection = vi.fn();
  const createHostPairing = vi.fn();
  const result = createGuideHarness({
    loadSetup: async () => ({
      setup: { ...setupSnapshot, status: "ready", existingModel: { provider: "ollama", model: "saved" } },
    }),
    loadHostConnection, downloadHostSetup, requestHostStoreConnection, createHostPairing,
    revokeHostConnection: vi.fn(),
  });
  disposers.push(result.guide.dispose);
  return { ...result, loadHostConnection, downloadHostSetup, requestHostStoreConnection, createHostPairing };
}

async function openComputer(h: ReturnType<typeof harness>) {
  await h.open();
  h.click("skip-embedding");
  await h.ready();
  h.submit();
  await vi.waitFor(() => expect(h.loadHostConnection).toHaveBeenCalledOnce());
  await h.ready();
}

test.each([true, false])("native Windows continues without pairing when direct discovery is %s", async (directAccessReady) => {
  const h = harness(nativeHost(directAccessReady));
  await openComputer(h);
  expect(h.container.innerHTML).not.toContain("data-system-host-store-connect");
  expect(h.container.innerHTML).not.toContain("apps.microsoft.com");
  expect(h.container.innerHTML).not.toContain('data-runtime-setup-action="skip-computer"');
  expect(h.container.innerHTML).not.toMatch(/type="submit"[^>]*disabled>Continue/);
  expect(h.applySetup).not.toHaveBeenCalled();
  h.submit();
  expect(h.container.innerHTML).toContain('data-runtime-setup-action="apply"');
  h.click("apply");
  await h.ready();
  expect(h.applySetup).toHaveBeenCalledOnce();
  expect(h.downloadHostSetup).not.toHaveBeenCalled();
  expect(h.requestHostStoreConnection).not.toHaveBeenCalled();
  expect(h.createHostPairing).not.toHaveBeenCalled();
});

test.each(["wsl", "container"])("a %s server retains Store setup despite direct Windows access", async (environment) => {
  const snapshot = nativeHost();
  snapshot.readiness.environment = environment;
  snapshot.collectionSource.mode = "companion";
  const h = harness(snapshot);
  await openComputer(h);
  expect(h.container.innerHTML).toContain("data-system-host-store-connect");
  expect(h.container.innerHTML).toMatch(/type="submit"[^>]*disabled>Continue/);
  h.submit();
  expect(h.container.innerHTML).not.toContain('data-runtime-setup-action="apply"');
  h.click("skip-computer");
  expect(h.container.innerHTML).toContain('data-runtime-setup-action="apply"');
  expect(h.createHostPairing).not.toHaveBeenCalled();
});

test("native Windows requires fresh host facts after returning to Computer", async () => {
  const h = harness();
  await openComputer(h);
  h.submit();
  let rejectRefresh!: (reason: Error) => void;
  h.loadHostConnection.mockImplementationOnce(() => new Promise<never>((_, reject) => { rejectRefresh = reject; }));
  h.click("back");
  expect(h.container.innerHTML).toMatch(/type="submit"[^>]*disabled>Continue/);
  rejectRefresh(new Error("Status unavailable"));
  await vi.waitFor(() => expect(h.container.innerHTML).toContain("Status unavailable"));
  h.submit();
  expect(h.container.innerHTML).not.toContain('data-runtime-setup-action="apply"');
  h.click("skip-computer");
  expect(h.container.innerHTML).toContain('data-runtime-setup-action="apply"');
  expect(h.requestHostStoreConnection).not.toHaveBeenCalled();
});
