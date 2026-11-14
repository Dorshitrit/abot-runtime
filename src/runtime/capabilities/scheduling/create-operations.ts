import { modelReasoningControlProperties } from "../model-reasoning-controls.js";
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
    summary: `Schedule a future request in this conversation with the current model. The prompt must fully instruct the assistant: explicitly remind the user of the exact action/target, or retain the delegated work. Put timing in schedule fields; ask if missing. Omit reasoningMode or use inherit for profile defaults; other modes require numeric reasoning support. ${timingSummary}`,
    effect: "mutating",
    approval: "request_policy",
    fixedParams: { action: "create", scheduleKind: kind },
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...scheduleDetailProperties,
  ...modelReasoningControlProperties,
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
