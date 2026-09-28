import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only component has no declaration surface.
import { createPassiveLearningHome } from "../../web-ui/app/components/passive-learning/home.js";
// @ts-expect-error Browser-only feature has no declaration surface.
import { createPassiveLearningFeature } from "../../web-ui/app/passive-learning-feature.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function stoppedStatus() {
  return {
    preferences: {
      enabled: false, processingPaused: true, modelProfileId: "saved-model",
      activityPermissions: { collection: true, learning: false, proactive: false },
      excludedApplications: ["private-app"], analysisIntervalMinutes: 15,
      analysisWindow: { start: "09:00", end: "17:00", timeZone: "UTC" },
      maxConcurrentBatches: 2,
    },
    state: "off", reason: "", pendingObservations: 0,
    processing: false, activeBatches: 0, recentMemories: [],
  };
}

function readySnapshot() {
  return {
    status: stoppedStatus() as ReturnType<typeof stoppedStatus> | null,
    hostConnection: { connected: true, readiness: { ready: true } } as Record<string, unknown> | null,
    saving: false, loadingStatus: false, statusError: "",
  };
}

function createRoot() {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  return document.createElement("section");
}

function homeHarness(snapshot = readySnapshot()) {
  const root = createRoot();
  const openLearning = vi.fn();
  const configure = vi.fn();
  const home = createPassiveLearningHome({
    openLearning, actions: { snapshot: () => snapshot, configure },
  });
  home.mount(root);
  home.render(snapshot);
  const button = root.querySelector("[data-learning-open]")!;
  return { root, home, snapshot, button, configure, openLearning };
}

afterEach(() => vi.unstubAllGlobals());

describe("Home Co-worker quick action", () => {
  test.each([0, 3])("opens idle processing with %i pending observations without enabling collection", (pending) => {
    const snapshot = readySnapshot();
    snapshot.status!.preferences.processingPaused = false;
    snapshot.status!.pendingObservations = pending;
    snapshot.hostConnection = null;
    const before = structuredClone(snapshot.status!.preferences);
    const h = homeHarness(snapshot);
    expect(h.button.textContent).toBe("Open ABot Spark");
    h.button.dispatch("click");
    expect(h.openLearning).toHaveBeenCalledOnce();
    expect(h.configure).not.toHaveBeenCalled();
    expect(snapshot.status!.preferences).toEqual(before);
  });

  test("starts a ready saved configuration without changing processing or schedule preferences", () => {
    const h = homeHarness();
    const preferences = structuredClone(h.snapshot.status!.preferences);
    expect(h.root.hidden).toBe(false);
    expect(h.root.querySelector(".home-learning-summary")).toBeNull();
    expect(h.button.textContent).toBe("Start ABot Spark");
    h.button.dispatch("click");
    expect(h.configure).toHaveBeenCalledExactlyOnceWith({ enabled: true });
    expect(h.snapshot.status!.preferences).toEqual(preferences);
    expect(h.openLearning).not.toHaveBeenCalled();
  });

  test.each([
    ["not connected", (s: ReturnType<typeof readySnapshot>) => { s.hostConnection = null; }],
    ["setup required despite connection", (s: ReturnType<typeof readySnapshot>) => {
      s.hostConnection = { connected: true, readiness: { ready: false } };
    }],
    ["no saved model", (s: ReturnType<typeof readySnapshot>) => { s.status!.preferences.modelProfileId = ""; }],
    ["status error", (s: ReturnType<typeof readySnapshot>) => { s.statusError = "Status unavailable"; }],
    ["processing failure", (s: ReturnType<typeof readySnapshot>) => {
      s.status!.state = "failed"; s.status!.reason = "learning_memory_unavailable";
    }],
  ])("opens setup without a mutation when %s", (_name, change) => {
    const snapshot = readySnapshot();
    change(snapshot);
    const h = homeHarness(snapshot);
    expect(h.button.textContent).toBe("Set up ABot Spark");
    h.button.dispatch("click");
    expect(h.openLearning).toHaveBeenCalledOnce();
    expect(h.configure).not.toHaveBeenCalled();
  });

  test("keeps the setup entry visible before any status or installation is available", () => {
    const snapshot = readySnapshot();
    snapshot.status = null;
    snapshot.hostConnection = null;
    const h = homeHarness(snapshot);
    expect(h.root.hidden).toBe(false);
    expect(h.root.querySelector(".home-learning-summary")).toBeNull();
    expect(h.button.textContent).toBe("Set up ABot Spark");
    h.button.dispatch("click");
    expect(h.openLearning).toHaveBeenCalledOnce();
    expect(h.configure).not.toHaveBeenCalled();
  });

  test("keeps saved knowledge out of Home while retaining the Co-worker entry", () => {
    const h = homeHarness();
    h.home.render({ ...h.snapshot, status: {
      ...h.snapshot.status,
      recentMemories: [{ id: "saved", content: "Saved context", createdAt: "2026-09-25T08:00:00Z" }],
    } });
    expect(h.root.querySelector("[data-learning-memories]")).toBeNull();
    expect(h.root.textContent).not.toContain("Saved context");
    expect(h.button.hidden).toBe(false);
  });

  test("opens an enabled Co-worker without resuming automatic collection or processing pauses", () => {
    const snapshot = readySnapshot();
    snapshot.status!.preferences.enabled = true;
    snapshot.status!.state = "paused";
    snapshot.status!.reason = "continuous_activity";
    const h = homeHarness(snapshot);
    expect(h.button.textContent).toBe("Open ABot Spark");
    h.button.dispatch("click");
    expect(h.openLearning).toHaveBeenCalledOnce();
    expect(h.configure).not.toHaveBeenCalled();
    expect(snapshot.status!.preferences.processingPaused).toBe(true);
  });

  test.each(["saving", "loadingStatus"] as const)("disables the action during %s", (field) => {
    const h = homeHarness();
    h.snapshot[field] = true;
    h.home.render(h.snapshot);
    expect(h.button.disabled).toBe(true);
    h.button.dispatch("click");
    expect(h.configure).not.toHaveBeenCalled();
    expect(h.openLearning).not.toHaveBeenCalled();
  });

  test("reads current saving state before a repeated click, even before a presentation refresh", () => {
    const h = homeHarness();
    h.snapshot.saving = true;
    h.button.dispatch("click");
    expect(h.configure).not.toHaveBeenCalled();
  });

  test("uses the feature's existing controller to serialize starts and display a rejected mutation", async () => {
    vi.stubGlobal("document", { visibilityState: "visible" });
    const root = createRoot();
    const learningRoot = createRoot();
    const status = stoppedStatus();
    let rejectStart!: (error: Error) => void;
    const client = {
      loadPassiveLearning: vi.fn(async () => ({ ok: true, status })),
      getSystemHostConnection: vi.fn(async () => ({ readiness: { ready: true } })),
      configurePassiveLearning: vi.fn(() => new Promise((_resolve, reject) => { rejectStart = reject; })),
    };
    const openLearning = vi.fn();
    const feature = createPassiveLearningFeature({
      client, getEnvironmentId: () => "dev", learningRoot,
      openLearning, showActivityMemories: vi.fn(), openComputerAccess: vi.fn(),
    });
    feature.mountHome(root);
    feature.setWorkspace("home");
    const button = root.querySelector("[data-learning-open]")!;
    await vi.waitFor(() => expect(button.textContent).toBe("Start ABot Spark"));
    button.dispatch("click");
    expect(button.disabled).toBe(true);
    button.dispatch("click");
    expect(client.configurePassiveLearning).toHaveBeenCalledExactlyOnceWith({ enabled: true }, "dev");
    rejectStart(new Error("Start rejected"));
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(root.querySelector("[data-learning-status]")?.textContent).toContain("Start rejected");
    expect(button.textContent).toBe("Set up ABot Spark");
    expect(learningRoot.querySelector('[data-learning-panel="insights"]')?.hidden).toBe(false);
    openLearning.mockReturnValueOnce(false);
    button.dispatch("click");
    expect(learningRoot.querySelector('[data-learning-panel="insights"]')?.hidden).toBe(false);
    button.dispatch("click");
    expect(openLearning).toHaveBeenCalledTimes(2);
    expect(learningRoot.querySelector('[data-learning-panel="settings"]')?.hidden).toBe(false);
    expect(learningRoot.querySelector('[data-learning-panel="insights"]')?.hidden).toBe(true);
    expect(client.configurePassiveLearning).toHaveBeenCalledTimes(1);
    expect(feature.snapshot().status.preferences).toEqual(status.preferences);
  });
});
