import { describe, expect, test } from "vitest";
// @ts-expect-error Browser component has no declarations.
import { learningWidgetPreview } from "../../web-ui/app/components/passive-learning/home-widget-preview.js";
// @ts-expect-error Browser component has no declarations.
import { coWorkerActivityStates } from "../../web-ui/app/components/passive-learning/agent-state.js";

function status() {
  return {
    preferences: {
      enabled: true, processingPaused: false, proactiveEnabled: true, modelProfileId: "model",
      analysisTrigger: "observations", analysisObservationCount: 100,
    },
    state: "collecting", collectionState: "collecting", processing: false, pendingObservations: 0,
    proactive: { state: "waiting" }, reassessment: { state: "waiting" },
  };
}

describe("Home learning widget preview", () => {
  test("does not invent metrics without status preferences", () => {
    for (const missing of [undefined, null, {}, { preferences: null }]) {
      expect(learningWidgetPreview(missing)).toBeNull();
    }
  });

  test("shows independent collecting, ready learning, and enabled proactive states", () => {
    const preview = learningWidgetPreview(status());
    expect(preview.kind).toBe("metrics");
    expect(preview.items.map((item: { label: string }) => item.label)).toEqual(["Collection", "Learning", "Proactive"]);
    expect(preview.items.map((item: { indicator: unknown }) => item.indicator)).toMatchObject([
      { icon: "collecting", tone: "active" },
      { icon: "success", tone: "success" },
      { icon: "success", tone: "success" },
    ]);
    expect(preview.items[1].indicator).not.toHaveProperty("value");
  });

  test("only exposes a positive finite eligible observation count", () => {
    const current = { ...status(), pendingObservations: 23, blockedObservations: 70 };
    expect(learningWidgetPreview(current).items[1].indicator.value).toBe(23);
    for (const pendingObservations of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "23", undefined]) {
      const indicator = learningWidgetPreview({ ...current, pendingObservations }).items[1].indicator;
      expect(indicator).not.toHaveProperty("value");
    }
  });

  test("retains paused states instead of presenting a waiting count", () => {
    const current = status();
    current.preferences = { ...current.preferences, enabled: false, processingPaused: true, proactiveEnabled: false };
    current.pendingObservations = 23;
    const preview = learningWidgetPreview(current);
    for (const item of preview.items) {
      expect(item.indicator).toMatchObject({ icon: "paused", tone: "neutral" });
      expect(item.indicator).not.toHaveProperty("value");
    }
  });

  test("does not let queued observations hide failure or an exhausted budget", () => {
    for (const state of ["failed", "budget_limited"]) {
      const current = { ...status(), pendingObservations: 23, reassessment: { state }, proactive: { state } };
      for (const item of learningWidgetPreview(current).items.slice(1)) {
        expect(item.indicator).toMatchObject({ icon: "failed", tone: "attention" });
        expect(item.indicator).not.toHaveProperty("value");
      }
    }
    const failed = learningWidgetPreview({ ...status(), collectionState: "disconnected", processingReason: "learning_model_request_failed", pendingObservations: 23 });
    expect(failed.items[0].indicator).toMatchObject({ icon: "failed", tone: "attention" });
    expect(failed.items[1].indicator).toMatchObject({ icon: "failed", tone: "attention" });
    expect(failed.items[1].indicator).not.toHaveProperty("value");
  });

  test("preserves a running review indicator including an already active batch after pausing", () => {
    const current = { ...status(), pendingObservations: 23, reassessment: { state: "reviewing" }, proactive: { state: "reviewing" } };
    for (const item of learningWidgetPreview(current).items.slice(1)) {
      expect(item.indicator).toMatchObject({ icon: "active", tone: "active" });
      expect(item.indicator).not.toHaveProperty("value");
    }
    const paused = { ...current, activeBatches: 1, preferences: { ...current.preferences, processingPaused: true } };
    expect(learningWidgetPreview(paused).items[1].indicator).toMatchObject({ icon: "active", tone: "active" });
    expect(learningWidgetPreview(paused).items[1].indicator).not.toHaveProperty("value");
  });

  test("retains the owner labels and detail for accessibility without mutating the snapshot", () => {
    const current = { ...status(), pendingObservations: 23 };
    const before = structuredClone(current);
    const states = coWorkerActivityStates(current);
    const preview = learningWidgetPreview(current);
    for (const [index, key] of ["collection", "processing", "proactive"].entries()) {
      const indicator = preview.items[index].indicator;
      expect(indicator.label).toContain(preview.items[index].label);
      for (const detail of states[key]) {
        if (detail) expect(indicator.label).toContain(detail);
      }
    }
    preview.items[1].indicator.value = 99;
    expect(current).toEqual(before);
    expect(learningWidgetPreview(current).items[1].indicator.value).toBe(23);
  });
});
