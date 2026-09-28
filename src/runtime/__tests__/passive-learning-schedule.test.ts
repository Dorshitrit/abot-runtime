import { describe, expect, it } from "vitest";
import {
  isWithinAnalysisWindow,
  nextAnalysisInstant,
} from "../passive-learning/analysis-schedule.js";
import {
  DEFAULT_LEARNING_PREFERENCES,
  normalizeLearningPreferences,
} from "../passive-learning/store.js";

const at = (iso: string) => Date.parse(iso);
describe("passive analysis scheduling", () => {
  it("defaults new installations to fifteen-minute batches, all hours and serial work", () => {
    expect(
      normalizeLearningPreferences({}, DEFAULT_LEARNING_PREFERENCES),
    ).toMatchObject({
      analysisIntervalMinutes: 15,
      analysisWindow: null,
      maxConcurrentBatches: 1,
    });
  });
  it("rejects invalid cadence, concurrency, timezone and clock values", () => {
    for (const input of [
      { analysisIntervalMinutes: 0 },
      { analysisIntervalMinutes: 1.5 },
      { analysisIntervalMinutes: 1441 },
      { maxConcurrentBatches: 0 },
      { maxConcurrentBatches: 9 },
      { analysisWindow: { start: "24:00", end: "12:00", timeZone: "UTC" } },
      {
        analysisWindow: {
          start: "08:00",
          end: "12:00",
          timeZone: "missing/zone",
        },
      },
    ])
      expect(() =>
        normalizeLearningPreferences(input, DEFAULT_LEARNING_PREFERENCES),
      ).toThrow("invalid_learning_preferences");
  });
  it("honors an overnight window and treats equal boundaries as all hours", () => {
    const window = { start: "22:00", end: "06:00", timeZone: "UTC" };
    expect(isWithinAnalysisWindow(at("2026-09-23T23:30:00Z"), window)).toBe(
      true,
    );
    expect(isWithinAnalysisWindow(at("2026-09-24T05:59:00Z"), window)).toBe(
      true,
    );
    expect(isWithinAnalysisWindow(at("2026-09-24T06:00:00Z"), window)).toBe(
      false,
    );
    expect(nextAnalysisInstant(at("2026-09-24T06:00:00Z"), window)).toBe(
      at("2026-09-24T22:00:00Z"),
    );
    expect(
      isWithinAnalysisWindow(at("2026-09-23T12:30:00Z"), {
        ...window,
        end: "22:00",
      }),
    ).toBe(true);
  });
  it("uses canonical DST behavior for missing daily start times", () => {
    const window = {
      start: "02:30",
      end: "04:00",
      timeZone: "America/New_York",
    };
    expect(nextAnalysisInstant(at("2026-03-08T06:00:00Z"), window)).toBe(
      at("2026-03-09T06:30:00Z"),
    );
  });
  it("allows explicit activity in an already-open DST window", () => {
    const window = {
      start: "01:30",
      end: "02:30",
      timeZone: "America/New_York",
    };
    expect(isWithinAnalysisWindow(at("2026-11-01T06:45:00Z"), window)).toBe(
      true,
    );
  });
});
