import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only feature.
import { createPassiveLearningFeature } from "../../web-ui/app/passive-learning-feature.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

type Entry = "Home" | "Spark" | "Settings";
async function fixture(entry: Entry, os = "macos", enabled = false) {
  vi.stubGlobal("document", { visibilityState: "visible" });
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  const learningRoot = document.createElement("section");
  const homeRoot = document.createElement("section");
  document.body.append(learningRoot);
  document.body.append(homeRoot);
  let environment = "dev";
  let status = {
    preferences: {
      enabled,
      processingPaused: true,
      modelProfileId: "local",
      proactiveEnabled: false,
      activityPermissions: { collection: entry !== "Settings", learning: false, proactive: false },
      excludedApplications: ["private-app"],
      analysisIntervalMinutes: 15,
      maxConcurrentBatches: 1,
    },
    state: enabled ? "collecting" : "off",
    deviceId: "mac-1",
    reason: "",
    pendingObservations: 0,
    processing: false,
    activeBatches: 0,
    recentMemories: [],
  };
  const host = {
    paired: true,
    connected: true,
    hostId: "mac-1",
    connectionId: "socket-1",
    identity: { os, name: "Alice Mac", user: "alice", homeDir: "/fixture/alice" },
    companion: { installedVersion: 6 },
    readiness: { ready: true },
  };
  const client = {
    loadPassiveLearning: vi.fn(async () => ({ ok: true, status })),
    getSystemHostConnection: vi.fn(async () => host),
    listPassiveLearningBatches: vi.fn(async () => ({ batches: [] })),
    listPassiveLearningCandidates: vi.fn(async () => ({ candidates: [] })),
    listModels: vi.fn(async () => ({
      profiles: [{ id: "local", label: "Local", provider: "ollama" }],
    })),
    configurePassiveLearning: vi.fn(
      async (preferences: Record<string, unknown>, _environment: string) => {
        status = {
          ...status,
          preferences: { ...status.preferences, ...preferences },
        };
        return { ok: true, status };
      },
    ),
  };
  const feature = createPassiveLearningFeature({
    client,
    getEnvironmentId: () => environment,
    learningRoot,
    openLearning: vi.fn(),
    showActivityMemories: vi.fn(),
    openComputerAccess: vi.fn(),
  });
  feature.mountHome(homeRoot);
  feature.setWorkspace(entry === "Home" ? "home" : "learning");
  await vi.waitFor(() =>
    expect(feature.snapshot().hostConnection).toEqual(host),
  );
  if (entry !== "Home")
    await vi.waitFor(() => expect(feature.snapshot().models).toHaveLength(1));
  if (entry === "Settings")
    learningRoot
      .querySelector('[data-learning-tab="settings"]')!
      .dispatch("click");
  const start = () => {
    if (entry === "Home")
      homeRoot.querySelector("[data-learning-open]")!.dispatch("click");
    else if (entry === "Spark")
      learningRoot.querySelector("[data-learning-toggle]")!.dispatch("click");
    else {
      const field = learningRoot.querySelector(
        '[data-learning-setting="collectionEnabled"]',
      )!;
      Object.assign(field, { checked: true });
      field.dispatch("change");
      learningRoot
        .querySelector("[data-learning-settings]")!
        .dispatch("submit");
    }
  };
  return {
    document,
    learningRoot,
    feature,
    client,
    start,
    host,
    changeEnvironment: () => {
      environment = "prod";
      feature.environmentChanged();
    },
    dialog: () => document.body.querySelector("dialog")!,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Mac consent through the real Spark feature composition", () => {
  test.each(["Home", "Spark"] as const)(
    "%s keeps collection and API untouched on Cancel, then Continue uses the original action",
    async (entry) => {
      const f = await fixture(entry);
      const before = structuredClone(f.feature.snapshot().status.preferences);
      f.start();
      expect(f.dialog()?.open).toBe(true);
      expect(
        f.dialog().querySelector("[data-mac-permission-path]")!.textContent,
      ).toBe("/fixture/alice/.abot/host-companion/runtime/node");
      expect(f.client.configurePassiveLearning).not.toHaveBeenCalled();
      expect(f.feature.snapshot().saving).toBe(false);
      expect(f.feature.snapshot().status.preferences).toEqual(before);
      f.dialog()
        .querySelector("[data-mac-permission-cancel]")!
        .dispatch("click");
      await Promise.resolve();
      expect(f.client.configurePassiveLearning).not.toHaveBeenCalled();
      expect(f.feature.snapshot().status.preferences).toEqual(before);
      f.start();
      expect(f.dialog().open).toBe(true);
      f.dialog()
        .querySelector("[data-mac-permission-continue]")!
        .dispatch("click");
      await vi.waitFor(() =>
        expect(f.client.configurePassiveLearning).toHaveBeenCalledOnce(),
      );
      const [preferences, environment] =
        f.client.configurePassiveLearning.mock.calls[0]!;
      expect(environment).toBe("dev");
      expect(preferences).toEqual({ enabled: true });
      expect(
        f.feature.snapshot().status.preferences.excludedApplications,
      ).toEqual(["private-app"]);
      expect(f.feature.snapshot().status.preferences.processingPaused).toBe(
        true,
      );
    },
  );

  test("saving a collection permission never prompts or starts the Mac collector", async () => {
    const f = await fixture("Settings");
    f.start();
    await vi.waitFor(() => expect(f.client.configurePassiveLearning).toHaveBeenCalledOnce());
    const [preferences, environment] = f.client.configurePassiveLearning.mock.calls[0]!;
    expect(preferences).toMatchObject({ activityPermissions: { collection: true, learning: false, proactive: false } });
    expect(preferences).not.toHaveProperty("enabled");
    expect(environment).toBe("dev");
    expect(f.feature.snapshot().status.preferences.enabled).toBe(false);
    expect(f.dialog()).toBeNull();
  });

  test.each(["environment", "host", "workspace"] as const)(
    "%s change cancels the pending explanation before Continue can mutate",
    async (change) => {
      const f = await fixture("Spark");
      f.start();
      const dialog = f.dialog();
      if (change === "environment") f.changeEnvironment();
      if (change === "host")
        f.feature.handleRealtime({ type: "system-host.changed" });
      if (change === "workspace") f.feature.setWorkspace("home");
      expect(dialog.open).toBe(false);
      dialog.querySelector("[data-mac-permission-continue]")!.dispatch("click");
      await Promise.resolve();
      expect(f.client.configurePassiveLearning).not.toHaveBeenCalled();
    },
  );

  test.each(["windows", "linux"])(
    "%s starts normally without mounting a Mac dialog",
    async (os) => {
      const f = await fixture("Spark", os);
      f.start();
      await vi.waitFor(() =>
        expect(
          f.client.configurePassiveLearning,
        ).toHaveBeenCalledExactlyOnceWith({ enabled: true }, "dev"),
      );
      expect(f.dialog()).toBeNull();
    },
  );

  test("mounting saved enabled collection never adds a consent or configure request, and Stop works directly", async () => {
    const f = await fixture("Spark", "macos", true);
    expect(f.client.configurePassiveLearning).not.toHaveBeenCalled();
    expect(f.dialog()).toBeNull();
    f.start();
    await vi.waitFor(() =>
      expect(f.client.configurePassiveLearning).toHaveBeenCalledExactlyOnceWith(
        { enabled: false },
        "dev",
      ),
    );
    expect(f.dialog()).toBeNull();
  });
});
