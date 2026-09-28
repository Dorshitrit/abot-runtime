import { describe, expect, it } from "vitest";
import { learningApplicationCatalog } from "../passive-learning/application-catalog.js";
import { normalizeLearningPreferences, DEFAULT_LEARNING_PREFERENCES } from "../passive-learning/store.js";
import { readLearningPreferencesInput } from "../local-host/learning-preferences-input.js";
import type { LearningObservation } from "../passive-learning/contracts.js";

function observation(id: string, app: string): LearningObservation {
  return { id, deviceId: "device", timestamp: "2026-09-25T12:00:00Z", sequence: 1,
    source: { app, title: "Must not leak a window title", windowId: "window" }, content: "Private content",
    kind: "view", extraction: "uia", coverage: "complete" };
}

describe("bounded application metadata and preferences", () => {
  it("counts retained unique evidence and exposes only app metadata", () => {
    const a = observation("a", "Firefox");
    const b = observation("b", "firefox");
    const preferences = { ...DEFAULT_LEARNING_PREFERENCES, excludedApplications: ["FIREFOX", "Private"],
      processingExcludedApplications: ["private"] };
    const result = learningApplicationCatalog([a, b], [{ id: "batch", generation: "generation", createdAt: a.timestamp,
      status: "saved", recordIds: [], observations: [a] }], preferences);
    expect(result).toEqual({ applicationsOmitted: 0, applications: [
      { app: "FIREFOX", observationCount: 2, lastObservedAt: a.timestamp, collectionExcluded: true, processingExcluded: false },
      { app: "private", observationCount: 0, collectionExcluded: true, processingExcluded: true },
    ] });
    expect(JSON.stringify(result)).not.toContain("Private content");
    expect(JSON.stringify(result)).not.toContain("window");
  });

  it("bounds recent apps while always exposing all configured rules", () => {
    const preferences = { ...DEFAULT_LEARNING_PREFERENCES,
      excludedApplications: Array.from({ length: 100 }, (_, i) => `collection-${i}`),
      processingExcludedApplications: Array.from({ length: 100 }, (_, i) => `processing-${i}`) };
    const result = learningApplicationCatalog(Array.from({ length: 120 }, (_, i) => observation(`${i}`, `app-${i}`)), [], preferences);
    expect(result.applications).toHaveLength(300);
    expect(result.applicationsOmitted).toBe(20);
    expect(result.applications.filter((row) => row.collectionExcluded || row.processingExcluded)).toHaveLength(200);
  });

  it("defaults old preferences to no processing exclusions and preserves independent rules", () => {
    const previous = normalizeLearningPreferences({ enabled: true, excludedApplications: ["Editor"] }, DEFAULT_LEARNING_PREFERENCES);
    expect(previous.processingExcludedApplications).toEqual([]);
    const patch = readLearningPreferencesInput({ processingExcludedApplications: [" Firefox ", "FIREFOX"] });
    expect(patch).toEqual({ processingExcludedApplications: ["FIREFOX"] });
    const next = normalizeLearningPreferences(patch, previous);
    expect(next.excludedApplications).toEqual(["Editor"]);
    expect(next.enabled).toBe(true);
  });

  it.each([null, "app", [""], ["bad\nname"], ["x".repeat(129)], Array.from({ length: 101 }, () => "app")])(
    "rejects invalid processing rules at the transport boundary: %j", (rules) => {
      expect(() => readLearningPreferencesInput({ processingExcludedApplications: rules })).toThrow();
    },
  );
});
