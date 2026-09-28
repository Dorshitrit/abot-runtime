import { afterEach, expect, test, vi } from "vitest";
import {
  createGuideHarness,
  setupSnapshot,
} from "./support/runtime-setup-guide-harness.js";
const disposers: Array<() => void> = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));
function harness(ready: boolean, failure = false) {
  const loadHostConnection = vi.fn(async () => {
    if (failure) throw new Error("Unavailable");
    return {
      paired: false,
      connected: false,
      readiness: {
        ready,
        route: ready ? "native" : "setup_required",
        environment: ready ? "native" : "container",
        platforms: ready ? [] : ["windows", "macos"],
        restartRequired: false,
      },
    };
  });
  const downloadHostSetup = vi.fn();
  const result = createGuideHarness({
    loadSetup: async () => ({
      setup: {
        ...setupSnapshot,
        status: "ready",
        existingModel: { provider: "ollama", model: "saved" },
      },
    }),
    loadHostConnection,
    downloadHostSetup,
    revokeHostConnection: vi.fn(),
  });
  disposers.push(result.guide.dispose);
  return { ...result, loadHostConnection, downloadHostSetup };
}
async function openComputer(h: ReturnType<typeof harness>) {
  await h.open();
  h.click("skip-embedding");
  await h.ready();
  h.submit();
  await vi.waitFor(() => expect(h.loadHostConnection).toHaveBeenCalledOnce());
  await h.ready();
}
test("inserts optional Computer after Plugins and keeps native readiness installation-free", async () => {
  const h = harness(true);
  await openComputer(h);
  expect(h.container.innerHTML).toContain("Set up computer access");
  expect(h.container.innerHTML).toContain("No extra installation");
  expect(h.downloadHostSetup).not.toHaveBeenCalled();
  expect(h.applySetup).not.toHaveBeenCalled();
  h.submit();
  expect(h.container.innerHTML).toContain("Ready to finish");
  h.click("apply");
  await h.ready();
  expect(h.applySetup).toHaveBeenCalledOnce();
});
test("container setup offers both native platforms and can be skipped without side effects", async () => {
  const h = harness(false);
  await openComputer(h);
  expect(h.container.innerHTML).toContain('data-system-host-install="windows"');
  expect(h.container.innerHTML).toContain('data-system-host-mac="manual"');
  expect(h.container.innerHTML).not.toContain('data-system-host-install="macos"');
  h.submit();
  expect(h.container.innerHTML).toContain("Set up computer access");
  h.click("skip-computer");
  expect(h.container.innerHTML).toContain("Ready to finish");
  expect(h.downloadHostSetup).not.toHaveBeenCalled();
  expect(h.applySetup).not.toHaveBeenCalled();
  h.click("back");
  expect(h.container.innerHTML).toContain("Set up computer access");
});
test("a readiness error leaves Skip available and does not block the model setup", async () => {
  const h = harness(false, true);
  await openComputer(h);
  expect(h.container.innerHTML).toContain("Could not check this computer");
  h.click("skip-computer");
  h.click("apply");
  await h.ready();
  expect(h.applySetup).toHaveBeenCalledOnce();
});
test("requires fresh readiness after returning to Computer and preserves Skip after refresh fails", async () => {
  const h = harness(true);
  await openComputer(h);
  h.submit();
  expect(h.container.innerHTML).toContain("Ready to finish");
  let rejectRefresh!: (reason: Error) => void;
  h.loadHostConnection.mockImplementationOnce(
    () =>
      new Promise<never>((_, reject) => {
        rejectRefresh = reject;
      }),
  );
  h.click("back");
  expect(h.container.innerHTML).toMatch(/type="submit"[^>]*disabled>Continue/);
  expect(h.container.innerHTML).toContain("Checking this computer");
  expect(h.container.innerHTML).not.toContain("No extra installation");
  h.submit();
  expect(h.container.innerHTML).toContain("Set up computer access");
  rejectRefresh(new Error("Offline"));
  await vi.waitFor(() =>
    expect(h.container.innerHTML).toContain("Status unavailable"),
  );
  expect(h.container.innerHTML).toMatch(/type="submit"[^>]*disabled>Continue/);
  h.submit();
  expect(h.container.innerHTML).toContain("Set up computer access");
  h.click("skip-computer");
  expect(h.container.innerHTML).toContain("Ready to finish");
  expect(h.container.innerHTML).not.toContain("No extra installation");
});
