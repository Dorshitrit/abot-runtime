import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only component has no declaration surface.
import { createPassiveLearningMemory } from "../../web-ui/app/components/passive-learning/memory.js";
// @ts-expect-error Browser-only feature has no declaration surface.
import { createPassiveLearningFeature } from "../../web-ui/app/passive-learning-feature.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function createRoot() {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  return document.createElement("section");
}

afterEach(() => vi.unstubAllGlobals());

test("a companion update navigates to Computer access without changing collection", () => {
  const root = createRoot();
  const snapshot = {
    status: null,
    models: [],
    batches: [],
    selectedBatch: null,
    hostConnection: {
      companion: {
        installedVersion: 1,
        availableVersion: 2,
        updateAvailable: true,
      },
    },
  };
  const configure = vi.fn();
  const openComputerAccess = vi.fn();
  const view = createPassiveLearningMemory({
    actions: {
      snapshot: () => snapshot,
      configure,
      refresh: vi.fn(),
      selectBatch: vi.fn(),
    },
    showActivityMemories: vi.fn(),
    openComputerAccess,
  });
  view.mount(root as never);
  expect(root.querySelector("[data-learning-update]")?.hidden).toBe(false);
  expect(
    root.querySelector("[data-learning-companion-version]")?.textContent,
  ).toContain("Installed version: 1");
  root.querySelector("[data-learning-open-update]")!.dispatch("click");
  expect(openComputerAccess).toHaveBeenCalledTimes(1);
  expect(configure).not.toHaveBeenCalled();
  view.render({
    ...snapshot,
    hostConnection: {
      companion: {
        installedVersion: 2,
        availableVersion: 2,
        updateAvailable: false,
      },
    },
  });
  expect(root.querySelector("[data-learning-update]")?.hidden).toBe(true);
});

test("Home and Co-worker share the update notice and clear it when the companion changes", async () => {
  vi.stubGlobal("document", { visibilityState: "visible" });
  const home = createRoot();
  const learning = createRoot();
  const client = {
    loadPassiveLearning: vi.fn(async () => ({ status: { preferences: { enabled: false } } })),
    getSystemHostConnection: vi.fn<() => Promise<unknown>>(async () => null),
    configurePassiveLearning: vi.fn(),
  };
  const openComputerAccess = vi.fn();
  const openLearning = vi.fn();
  const feature = createPassiveLearningFeature({
    client, getEnvironmentId: () => "dev", learningRoot: learning,
    openLearning, openComputerAccess, showActivityMemories: vi.fn(),
  });
  feature.mountHome(home);
  feature.setWorkspace("home");
  const notices = [home, learning].map((root) => root.querySelector("[data-learning-update]")!);
  try {
    await vi.waitFor(() => expect(client.getSystemHostConnection).toHaveBeenCalledOnce());
    expect(notices.every((notice) => notice.hidden)).toBe(true);
    client.getSystemHostConnection.mockResolvedValue({ companion: { updateAvailable: true } });
    feature.handleRealtime({ type: "system-host.changed" });
    await vi.waitFor(() => expect(notices.every((notice) => !notice.hidden)).toBe(true));
    for (const root of [home, learning])
      root.querySelector("[data-learning-open-update]")!.dispatch("click");
    expect(openComputerAccess).toHaveBeenCalledTimes(2);
    expect(openLearning).not.toHaveBeenCalled();
    expect(client.configurePassiveLearning).not.toHaveBeenCalled();

    client.getSystemHostConnection.mockResolvedValue({ companion: { updateAvailable: false } });
    feature.handleRealtime({ type: "system-host.changed" });
    await vi.waitFor(() => expect(notices.every((notice) => notice.hidden)).toBe(true));
  } finally {
    feature.setWorkspace("config");
  }
});
