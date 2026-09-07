import type { ToolNormalInvocationOperation } from "../../../capabilities/tool-types.js";
import type { SchedulerScheduleInput } from "../../scheduler/contracts.js";
import {
  scheduleDetailProperties,
  scheduleTimingProperties,
} from "./tool-input-properties.js";

function createScheduleOperation(
  kind: SchedulerScheduleInput["kind"],
  timingSummary: string,
  timingFields: readonly (keyof typeof scheduleTimingProperties)[],
  requiredTiming: readonly string[] = timingFields,
): ToolNormalInvocationOperation {
  return {
    operationId: `create_${kind}`,
    summary: `Schedule a future request in this conversation using the current model. Write prompt as the complete instruction the assistant must execute when this Job runs. For reminders, explicitly ask it to remind the user to act; preserve the exact action and target. For delegated work, retain the work itself. Put timing in the schedule fields and ask for missing timing details before creating. ${timingSummary}`,
    effect: "mutating",
    approval: "request_policy",
    fixedParams: { action: "create", scheduleKind: kind },
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...scheduleDetailProperties,
        timeZone: scheduleTimingProperties.timeZone,
        ...Object.fromEntries(
          timingFields.map((field) => [field, scheduleTimingProperties[field]]),
        ),
      },
      required: ["title", "prompt", ...requiredTiming],
    },
  };
}

export const scheduleCreateOperations = [
  createScheduleOperation("timer", "Run once after delayMs milliseconds.", [
    "delayMs",
  ]),
  createScheduleOperation(
    "once",
    "Run once at an exact ISO instant in at, including its UTC offset.",
    ["at"],
  ),
  createScheduleOperation(
    "interval",
    "Repeat everyMs milliseconds with optional exact first-run anchorAt ISO instant.",
    ["everyMs", "anchorAt"],
    ["everyMs"],
  ),
  createScheduleOperation(
    "daily",
    "Run daily at exact HH:mm in at and an explicit IANA timeZone.",
    ["at"],
    ["at", "timeZone"],
  ),
  createScheduleOperation(
    "weekly",
    "Run on weekdays (Sunday=0) at exact HH:mm in at and an explicit IANA timeZone.",
    ["at", "weekdays"],
    ["at", "weekdays", "timeZone"],
  ),
  createScheduleOperation(
    "monthly",
    "Run on dayOfMonth at exact HH:mm in at and an explicit IANA timeZone.",
    ["at", "dayOfMonth"],
    ["at", "dayOfMonth", "timeZone"],
  ),
] as const;
