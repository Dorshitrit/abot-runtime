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

  it.each(["ABot", "abot", " ABOT "])("hides built-in application %s even when saved as a user rule without activity", (app) => {
    const preferences = { ...DEFAULT_LEARNING_PREFERENCES,
      excludedApplications: [app], processingExcludedApplications: [app] };
    expect(learningApplicationCatalog([], [], preferences)).toEqual({ applications: [], applicationsOmitted: 0 });
    expect(preferences.excludedApplications).toEqual([app]);
    expect(preferences.processingExcludedApplications).toEqual([app]);
  });

  it("hides retained self observations while keeping browsers and similarly named apps configurable", () => {
    const own = observation("own", "ABot");
    const browser = { ...observation("browser", "Firefox"),
      source: { app: "Firefox", windowId: "browser", title: "ABot Runtime — Workspace — Mozilla Firefox" } };
    const result = learningApplicationCatalog([own, browser, observation("other", "ABot-helper")], [{
      id: "history", generation: "generation", createdAt: own.timestamp, status: "saved", recordIds: [],
      observations: [observation("old-own", "abot")],
    }], DEFAULT_LEARNING_PREFERENCES);
    expect(result.applications.map((row) => row.app)).toEqual(["Firefox", "ABot-helper"]);
    expect(result.applications.every((row) => !row.collectionExcluded && !row.processingExcluded)).toBe(true);
    expect(result.applicationsOmitted).toBe(0);
  });

  it("does not count a built-in application against the visible or omitted application limits", () => {
    const queued = [observation("own", "ABot"),
      ...Array.from({ length: 101 }, (_, index) => observation(String(index), `app-${index}`))];
    const result = learningApplicationCatalog(queued, [], DEFAULT_LEARNING_PREFERENCES);
    expect(result.applications).toHaveLength(100);
    expect(result.applications[0].app).toBe("app-0");
    expect(result.applications.at(-1)?.app).toBe("app-99");
    expect(result.applicationsOmitted).toBe(1);
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
