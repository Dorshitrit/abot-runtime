import { describe, expect, it } from "vitest";
import { nextSchedulerOccurrence } from "../scheduler/next-occurrence.js";
import { normalizeSchedulerSchedule } from "../scheduler/schedule-validation.js";

describe("scheduler calendar recurrence", () => {
  it("requires exact calendar hours and explicit once offsets", () => {
    expect(() =>
      normalizeSchedulerSchedule({ kind: "daily", at: "morning" }, 0),
    ).toThrow("scheduler_exact_time_required");
    expect(() =>
      normalizeSchedulerSchedule({ kind: "once", at: "2026-09-06T09:00" }, 0),
    ).toThrow("explicit UTC offset");
    expect(() =>
      normalizeSchedulerSchedule(
        { kind: "weekly", at: "09:00", weekdays: [] },
        0,
      ),
    ).toThrow("at least one weekday");
  });
  it("rejects normalized nonexistent dates and out-of-range durations", () => {
    expect(() =>
      normalizeSchedulerSchedule({ kind: "once", at: "2026-02-31T09:00Z" }, 0),
    ).toThrow("invalid date");
    expect(() =>
      normalizeSchedulerSchedule(
        { kind: "timer", delayMs: Number.MAX_SAFE_INTEGER },
        0,
      ),
    ).toThrow("supported date range");
  });
  it("anchors intervals to creation plus one duration and retains cadence", () => {
    const schedule = normalizeSchedulerSchedule(
      { kind: "interval", everyMs: 7_200_000 },
      0,
    );
    expect(schedule).toEqual({
      kind: "interval",
      everyMs: 7_200_000,
      anchorAt: "1970-01-01T02:00:00.000Z",
    });
    expect(nextSchedulerOccurrence(schedule, "UTC", 7_200_001)).toBe(
      "1970-01-01T04:00:00.000Z",
    );
  });
  it("supports multiple weekdays in the chosen timezone", () => {
    expect(
      nextSchedulerOccurrence(
        { kind: "weekly", at: "09:00", weekdays: [3, 6] },
        "Asia/Jerusalem",
        Date.parse("2026-09-05T07:00:00Z"),
      ),
    ).toBe("2026-09-09T06:00:00.000Z");
  });
  it("skips a nonexistent spring-forward wall time", () => {
    expect(
      nextSchedulerOccurrence(
        { kind: "daily", at: "02:30" },
        "America/New_York",
        Date.parse("2026-03-08T00:00:00Z"),
      ),
    ).toBe("2026-03-09T06:30:00.000Z");
  });
  it("selects the first fall-back occurrence and never runs its duplicate", () => {
    const schedule = { kind: "daily" as const, at: "01:30" };
    const first = nextSchedulerOccurrence(
      schedule,
      "America/New_York",
      Date.parse("2026-11-01T00:00:00Z"),
    );
    expect(first).toBe("2026-11-01T05:30:00.000Z");
    expect(
      nextSchedulerOccurrence(schedule, "America/New_York", Date.parse(first!)),
    ).toBe("2026-11-02T06:30:00.000Z");
  });
  it("skips missing month days and respects non-hour timezones", () => {
    expect(
      nextSchedulerOccurrence(
        { kind: "monthly", at: "09:00", dayOfMonth: 31 },
        "Asia/Kathmandu",
        Date.parse("2026-02-01T00:00:00Z"),
      ),
    ).toBe("2026-03-31T03:15:00.000Z");
  });
  it("handles a skipped civil date without moving the requested time", () => {
    expect(
      nextSchedulerOccurrence(
        { kind: "daily", at: "09:00" },
        "Pacific/Apia",
        Date.parse("2011-12-29T20:00:00Z"),
      ),
    ).toBe("2011-12-30T19:00:00.000Z");
  });
});
