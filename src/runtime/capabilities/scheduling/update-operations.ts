import { modelReasoningControlProperties } from "../model-reasoning-controls.js";
import type {
  ToolNormalInvocationOperation,
  ToolNormalInvocationPropertyInput,
} from "../../../capabilities/tool-types.js";
import type { SchedulerScheduleInput } from "../../scheduler/contracts.js";
import {
  scheduleDetailProperties,
  scheduleTextField,
  scheduleTimingProperties,
} from "./tool-input-properties.js";

const editableJobProperties = {
  jobId: scheduleTextField(200),
  ...scheduleDetailProperties,
  ...modelReasoningControlProperties,
  modelProfileId: scheduleTextField(200),
  agentMode: { type: "string", enum: ["fast", "reasoning", "deep"] },
  timeZone: scheduleTimingProperties.timeZone,
} satisfies Record<string, ToolNormalInvocationPropertyInput>;

function updateScheduleOperation(
  kind: SchedulerScheduleInput["kind"],
  timingSummary: string,
  timingFields: readonly (keyof typeof scheduleTimingProperties)[],
  requiredTiming: readonly string[] = timingFields,
): ToolNormalInvocationOperation {
  return {
    operationId: `update_${kind}`,
    summary: `Replace this conversation's Job recurrence; ask for missing timing. Omit timeZone, modelProfileId and agentMode to retain saved settings. Omit reasoningMode to retain its setting for the same model; inherit clears it. Other modes require numeric reasoning support. ${timingSummary}`,
    effect: "mutating",
    approval: "request_policy",
    fixedParams: { action: "update", scheduleKind: kind },
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...editableJobProperties,
        ...Object.fromEntries(
          timingFields.map((field) => [field, scheduleTimingProperties[field]]),
        ),
      },
      required: ["jobId", ...requiredTiming],
    },
  };
}

export const scheduleUpdateOperations: readonly ToolNormalInvocationOperation[] =
  [
    {
      operationId: "update",
      summary:
        "Edit this conversation's Job title, prompt, model, mode or time zone, retaining recurrence. Use a kind-specific update to replace timing. modelProfileId must name an available configured model; omitted settings retain saved values. Omit reasoningMode to retain its setting for the same model; inherit clears it. Other modes require numeric reasoning support.",
      effect: "mutating",
      approval: "request_policy",
      fixedParams: { action: "update" },
      input: {
        type: "object",
        additionalProperties: false,
        properties: editableJobProperties,
        required: ["jobId"],
      },
    },
    updateScheduleOperation("timer", "Run once after delayMs milliseconds.", [
      "delayMs",
    ]),
    updateScheduleOperation(
      "once",
      "Run once at an exact ISO instant in at, including its UTC offset.",
      ["at"],
    ),
    updateScheduleOperation(
      "interval",
      "Repeat everyMs milliseconds with optional exact first-run anchorAt ISO instant.",
      ["everyMs", "anchorAt"],
      ["everyMs"],
    ),
    updateScheduleOperation("daily", "Run daily at exact HH:mm in at.", ["at"]),
    updateScheduleOperation(
      "weekly",
      "Run on weekdays (Sunday=0) at exact HH:mm in at.",
      ["at", "weekdays"],
    ),
    updateScheduleOperation(
      "monthly",
      "Run on dayOfMonth at exact HH:mm in at.",
      ["at", "dayOfMonth"],
    ),
  ];
