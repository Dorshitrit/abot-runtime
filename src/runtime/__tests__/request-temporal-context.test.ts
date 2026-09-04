import { describe, expect, test } from "vitest";

import {
  buildRequestTemporalContextMessage,
  captureRequestTemporalContext,
  REQUEST_TEMPORAL_CONTEXT_MESSAGE_KIND,
} from "../context/request-temporal-context.js";
import { estimateMessageTokens } from "../context/token-estimator.js";

describe("request temporal context", () => {
  test.each([
    {
      label: "New York summer time",
      observedAt: "2026-08-17T12:34:56.789Z",
      timeZone: "America/New_York",
      expected: "2026-08-17 08:34:56 GMT−04:00",
    },
    {
      label: "New York winter time",
      observedAt: "2026-01-17T12:34:56.789Z",
      timeZone: "America/New_York",
      expected: "2026-01-17 07:34:56 GMT−05:00",
    },
    {
      label: "UTC",
      observedAt: "2026-08-17T12:34:56.789Z",
      timeZone: "UTC",
      // ICU versions differ in how they spell a zero GMT offset.
      expected: expect.stringMatching(/^2026-08-17 12:34:56 GMT(?:\+00:00)?$/),
    },
  ])(
    "formats a frozen instant in $label",
    ({ observedAt, timeZone, expected }) => {
      const context = captureRequestTemporalContext({
        instant: new Date(observedAt),
        timeZone,
      });

      expect(context).toEqual({
        currentDateTime: expected,
        timeZone,
      });
      expect(Object.isFrozen(context)).toBe(true);
    },
  );

  test("builds one frozen passive runtime-clock capsule", () => {
    const temporalContext = captureRequestTemporalContext({
      instant: new Date("2026-08-17T12:34:56.789Z"),
      timeZone: "America/New_York",
    });
    const message = buildRequestTemporalContextMessage(temporalContext);

    expect(Object.isFrozen(message)).toBe(true);
    expect(message.role).toBe("system");
    expect(JSON.parse(message.content)).toEqual({
      kind: REQUEST_TEMPORAL_CONTEXT_MESSAGE_KIND,
      currentDateTime: temporalContext.currentDateTime,
      timeZone: temporalContext.timeZone,
      passive: "relative_time_reference_not_user_intent",
    });
  });

  test("keeps the fixed capsule within the request-context budget", () => {
    const temporalContext = captureRequestTemporalContext({
      instant: new Date("2026-08-17T12:34:56.789Z"),
      timeZone: "America/New_York",
    });
    const message = buildRequestTemporalContextMessage(temporalContext);
    const tokenDelta = estimateMessageTokens(message);

    expect(tokenDelta).toBeLessThanOrEqual(100);
  });

  test("rejects invalid instants and time zones", () => {
    expect(() =>
      captureRequestTemporalContext({
        instant: new Date("not-an-instant"),
        timeZone: "UTC",
      }),
    ).toThrow("request_temporal_context_instant_invalid");
    expect(() =>
      captureRequestTemporalContext({
        instant: new Date("2026-08-17T12:34:56.789Z"),
        timeZone: "Not/A_Time_Zone",
      }),
    ).toThrow("request_temporal_context_timezone_invalid");
  });

  test("snapshots the supplied clock", () => {
    const instant = new Date("2026-08-17T12:34:56.789Z");
    const context = captureRequestTemporalContext({
      instant,
      timeZone: "America/New_York",
    });
    instant.setUTCFullYear(2030);

    expect(context.currentDateTime).toBe("2026-08-17 08:34:56 GMT−04:00");
    expect(Object.isFrozen(context)).toBe(true);
  });
});
