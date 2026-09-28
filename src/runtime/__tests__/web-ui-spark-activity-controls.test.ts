import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only component.
import { createPassiveLearningMemory } from "../../web-ui/app/components/passive-learning/memory.js";
// @ts-expect-error Browser-only component.
import { createPassiveLearningHome } from "../../web-ui/app/components/passive-learning/home.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

const allAllowed = { collection: true, learning: true, proactive: true };
const noneAllowed = { collection: false, learning: false, proactive: false };
const controls = [
  { name: "collection", selector: "[data-learning-toggle]", permission: "collectionEnabled", model: "modelProfileId", key: "enabled", start: true },
  { name: "learning", selector: "[data-learning-processing-toggle]", permission: "processingEnabled", model: "modelProfileId", key: "processingPaused", start: false },
  { name: "proactive", selector: "[data-learning-proactive-toggle]", permission: "proactiveEnabled", model: "proactiveModelProfileId", key: "proactiveEnabled", start: true },
] as const;

function fixture(preferences: Record<string, unknown> = {}) {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  const root = document.createElement("section"), homeRoot = document.createElement("section");
  const snapshot: any = {
    environmentId: "dev", saving: false, loadingStatus: false, statusError: "",
    models: [{ id: "saved", label: "Learning" }, { id: "proactive", label: "Proactive" }],
    batches: [], selectedBatch: null, selectedBatchId: "", detailError: "", batchError: "", modelsError: "",
    hostConnection: { connected: true, readiness: { ready: true } },
    status: {
      preferences: { enabled: false, processingPaused: true, proactiveEnabled: false,
        modelProfileId: "saved", activityPermissions: allAllowed,
        collectionWindow: { start: "09:00", end: "17:00", timeZone: "UTC" },
        resourceLimits: { modelCallsPerDay: 20 }, ...preferences },
      state: "off", pendingObservations: 3, processing: false, activeBatches: 0, recentMemories: [],
    },
  };
  const configure = vi.fn(), clearPending = vi.fn(), openLearning = vi.fn(), openSetup = vi.fn();
  const actions = { snapshot: () => snapshot, configure, clearPending, refresh: vi.fn(), selectBatch: vi.fn() };
  const view = createPassiveLearningMemory({ actions, showActivityMemories: vi.fn() });
  const home = createPassiveLearningHome({ actions, openLearning, openSetup });
  view.mount(root); home.mount(homeRoot);
  const render = () => { view.render(snapshot); home.render(snapshot); };
  render();
  return { root, snapshot, configure, clearPending, openLearning, openSetup, render,
    homeButton: homeRoot.querySelector("[data-learning-open]")! };
}

describe("Spark permissions and independent activity controls", () => {
  test.each(controls)("starts and stops only $name while retaining its permission and pending work", (control) => {
    const f = fixture();
    const before = structuredClone(f.snapshot.status.preferences);
    const button = f.root.querySelector(control.selector)!;
    button.dispatch("click");
    expect(f.configure).toHaveBeenCalledExactlyOnceWith({ [control.key]: control.start });
    Object.assign(f.snapshot.status.preferences, f.configure.mock.calls[0]![0]);
    f.render();
    expect(button.dataset.actionTone).toBe("danger");
    button.dispatch("click");
    expect(f.configure).toHaveBeenLastCalledWith({ [control.key]: !control.start });
    expect(f.snapshot.status.preferences.activityPermissions).toEqual(allAllowed);
    expect(f.snapshot.status.preferences.resourceLimits).toEqual(before.resourceLimits);
    expect(f.snapshot.status.preferences.collectionWindow).toEqual(before.collectionWindow);
    expect(f.snapshot.status.pendingObservations).toBe(3);
    expect(f.clearPending).not.toHaveBeenCalled();
  });

  test.each(controls)("$name can stop even after its model disappears or permission changes", (control) => {
    const f = fixture({ [control.key]: control.start, activityPermissions: noneAllowed });
    f.snapshot.models = [];
    f.render();
    f.root.querySelector(control.selector)!.dispatch("click");
    expect(f.configure).toHaveBeenCalledExactlyOnceWith({ [control.key]: !control.start });
  });

  test.each(controls)("unapproved $name opens its permission checkbox without granting it", (control) => {
    const f = fixture({ activityPermissions: noneAllowed });
    const button = f.root.querySelector(control.selector)!;
    expect(button.dataset.actionTone).toBe("setup");
    expect(button.disabled).toBe(false);
    button.dispatch("click");
    expect(f.root.querySelector('[data-learning-panel="settings"]')!.hidden).toBe(false);
    expect(f.root.ownerDocument.activeElement).toBe(f.root.querySelector(`[data-learning-setting="${control.permission}"]`));
    expect(f.configure).not.toHaveBeenCalled();
  });

  test.each(controls)("$name with an unavailable saved model opens model setup", (control) => {
    const f = fixture({ modelProfileId: "removed", proactiveModelProfileId: "removed" });
    f.root.querySelector(control.selector)!.dispatch("click");
    expect(f.root.ownerDocument.activeElement).toBe(f.root.querySelector(`[data-learning-setting="${control.model}"]`));
    expect(f.configure).not.toHaveBeenCalled();
  });

  test("captures legacy active choices when stopping and can resume without approving dormant proactive mode", () => {
    const f = fixture({ enabled: true, processingPaused: false, activityPermissions: undefined });
    f.root.querySelector("[data-learning-toggle]")!.dispatch("click");
    expect(f.configure).toHaveBeenCalledExactlyOnceWith({ enabled: false,
      activityPermissions: { collection: true, learning: true, proactive: false } });
    Object.assign(f.snapshot.status.preferences, f.configure.mock.calls[0]![0]); f.render();
    f.root.querySelector("[data-learning-toggle]")!.dispatch("click");
    expect(f.configure).toHaveBeenLastCalledWith({ enabled: true });
    expect(f.root.querySelector("[data-learning-proactive-toggle]")!.dataset.actionTone).toBe("setup");
  });

  test("saved models alone never grant a stopped legacy activity", () => {
    const f = fixture({ activityPermissions: undefined, proactiveModelProfileId: "proactive" });
    for (const control of controls) expect(f.root.querySelector(control.selector)!.dataset.actionTone).toBe("setup");
    f.homeButton.dispatch("click");
    expect(f.openSetup).toHaveBeenCalledOnce();
    expect(f.configure).not.toHaveBeenCalled();
  });

  test("quick Start uses saved permissions and models without applying invalid Settings drafts", () => {
    const f = fixture();
    const model = f.root.querySelector('[data-learning-setting="modelProfileId"]')!;
    model.value = "removed"; model.dispatch("change");
    const interval = f.root.querySelector('[data-learning-setting="analysisIntervalMinutes"]')!;
    interval.value = "0"; interval.dispatch("change");
    f.root.querySelector("[data-learning-toggle]")!.dispatch("click");
    expect(f.configure).toHaveBeenCalledExactlyOnceWith({ enabled: true });
    expect(model.value).toBe("removed");
    expect(interval.value).toBe("0");
  });
});

describe("Home starts the saved allowed activities together", () => {
  test("starts all three with one mutation and preserves every saved policy", () => {
    const f = fixture();
    const before = structuredClone(f.snapshot.status.preferences);
    f.homeButton.dispatch("click");
    expect(f.configure).toHaveBeenCalledExactlyOnceWith({ enabled: true, processingPaused: false, proactiveEnabled: true });
    expect(f.snapshot.status.preferences).toEqual(before);
    expect(f.openLearning).not.toHaveBeenCalled();
  });

  test.each([
    [{ collection: true, learning: false, proactive: true }, { enabled: true, proactiveEnabled: true }],
    [{ collection: false, learning: true, proactive: true }, { processingPaused: false, proactiveEnabled: true }],
  ])("starts only permitted activities: %j", (activityPermissions, patch) => {
    const f = fixture({ activityPermissions });
    f.homeButton.dispatch("click");
    expect(f.configure).toHaveBeenCalledExactlyOnceWith(patch);
  });

  test.each([
    [{ collection: false, learning: true, proactive: false }, "saved", undefined, { processingPaused: false }],
    [{ collection: false, learning: false, proactive: true }, undefined, "proactive", { proactiveEnabled: true }],
  ])("starts an approved non-collection activity without a computer: %j", (activityPermissions, modelProfileId, proactiveModelProfileId, patch) => {
    const f = fixture({ activityPermissions, modelProfileId, proactiveModelProfileId });
    f.snapshot.hostConnection = null;
    f.render(); f.homeButton.dispatch("click");
    expect(f.configure).toHaveBeenCalledExactlyOnceWith(patch);
    expect(f.openSetup).not.toHaveBeenCalled();
  });

  test.each([
    { modelProfileId: undefined, proactiveModelProfileId: "proactive" },
    { activityPermissions: noneAllowed },
  ])("opens setup without partially starting when configuration is incomplete: %j", (preferences) => {
    const f = fixture(preferences);
    f.homeButton.dispatch("click");
    expect(f.openSetup).toHaveBeenCalledOnce();
    expect(f.configure).not.toHaveBeenCalled();
  });

  test("requires a ready computer when collection is allowed even if other activities are ready", () => {
    const f = fixture();
    f.snapshot.hostConnection = null;
    f.render(); f.homeButton.dispatch("click");
    expect(f.openSetup).toHaveBeenCalledOnce();
    expect(f.configure).not.toHaveBeenCalled();
  });
});
