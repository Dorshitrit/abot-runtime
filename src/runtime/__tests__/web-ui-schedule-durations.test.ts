import { describe, expect, it } from "vitest";
import {
  scheduleFormInput,
  scheduleUpdateInput,
} from "../../web-ui/app/components/schedules/form.js";

function durationForm(kind: "timer" | "interval", seconds: string) {
  const data = new FormData();
  data.set("kind", kind);
  data.set("seconds", seconds);
  data.set("title", "Original");
  data.set("prompt", "Saved work");
  data.set("sessionId", "session");
  data.set("modelProfileId", "model");
  data.set("agentMode", "fast");
  data.set("timeZone", "UTC");
  return data;
}

describe.each(["timer", "interval"] as const)(
  "%s editor duration precision",
  (kind) => {
    it.each([
      ["1", 1_000],
      ["1.001", 1_001],
      ["30", 30_000],
      ["90", 90_000],
      ["9007199254740.991", Number.MAX_SAFE_INTEGER],
    ] as const)(
      "preserves %s seconds as exactly %i milliseconds when editing metadata",
      (seconds, milliseconds) => {
        const data = durationForm(kind, seconds);
        const initial = scheduleFormInput(data);
        const durationField = kind === "timer" ? "delayMs" : "everyMs";
        expect(initial.schedule).toEqual({
          kind,
          [durationField]: milliseconds,
        });
        data.set("title", "Updated");
        expect(
          scheduleUpdateInput({ ...scheduleFormInput(data) }, { ...initial }),
        ).toEqual({ title: "Updated" });
      },
    );

    it("changes the duration by one exact millisecond when explicitly edited", () => {
      const data = durationForm(kind, "1.001");
      const initial = scheduleFormInput(data);
      data.set("seconds", "1.002");
      const durationField = kind === "timer" ? "delayMs" : "everyMs";
      expect(
        scheduleUpdateInput({ ...scheduleFormInput(data) }, { ...initial }),
      ).toEqual({ schedule: { kind, [durationField]: 1_002 } });
    });

    it.each([
      "",
      "0",
      "0.999",
      "-1",
      "1.0001",
      "Infinity",
      "NaN",
      "9007199254740.992",
    ])("rejects invalid duration %j without rounding it", (seconds) => {
      expect(() => scheduleFormInput(durationForm(kind, seconds))).toThrow(
        "Enter at least 1 second, in whole milliseconds.",
      );
    });

    it("accepts insignificant trailing zeros without changing the duration", () => {
      const input = scheduleFormInput(durationForm(kind, "1.001000"));
      const durationField = kind === "timer" ? "delayMs" : "everyMs";
      expect(input.schedule).toEqual({ kind, [durationField]: 1_001 });
    });
  },
);
