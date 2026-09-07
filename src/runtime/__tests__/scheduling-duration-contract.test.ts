import { describe, expect, it } from "vitest";
import { validateToolNormalInvocationInput } from "../../capabilities/normal-invocation/validator.js";
import { schedulingToolContract } from "../capabilities/scheduling/tool-contract.js";
import { normalizeSchedulerSchedule } from "../scheduler/schedule-validation.js";

describe.each(["create", "update"])(
  "%s scheduling duration contract",
  (operationId) => {
    const details =
      operationId === "create"
        ? { title: "Reminder", prompt: "Saved work" }
        : { jobId: "job" };

    it.each(["timer", "interval"] as const)(
      "matches runtime duration boundaries for %s",
      (kind) => {
        const selectedId = `${operationId}_${kind}`;
        const operation = schedulingToolContract.operations.find(
          (entry) => entry.operationId === selectedId,
        )!;
        for (const duration of [0, 1, 999, 1_000, 60_000]) {
          const durationField = kind === "timer" ? "delayMs" : "everyMs";
          const result = validateToolNormalInvocationInput(operation, {
            ...details,
            [durationField]: duration,
          });
          const schedule =
            kind === "timer"
              ? { kind, delayMs: duration }
              : { kind, everyMs: duration };
          if (duration < 1_000) {
            expect(result.ok).toBe(false);
            expect(() => normalizeSchedulerSchedule(schedule, 0)).toThrow(
              "scheduler_invalid_schedule",
            );
            continue;
          }
          expect(result.ok).toBe(true);
          expect(() => normalizeSchedulerSchedule(schedule, 0)).not.toThrow();
        }
      },
    );
  },
);
