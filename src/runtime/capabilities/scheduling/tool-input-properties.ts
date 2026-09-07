import type { ToolNormalInvocationPropertyInput } from "../../../capabilities/tool-types.js";

export const scheduleTextField = (
  maxLength: number,
): ToolNormalInvocationPropertyInput => ({
  type: "string",
  minLength: 1,
  maxLength,
});

export const scheduleTimingProperties = {
  scheduleKind: {
    type: "string",
    enum: ["timer", "once", "interval", "daily", "weekly", "monthly"],
  },
  at: scheduleTextField(64),
  delayMs: { type: "integer", minimum: 1_000, maximum: 31_536_000_000 },
  everyMs: { type: "integer", minimum: 1_000, maximum: 31_536_000_000 },
  anchorAt: scheduleTextField(64),
  weekdays: {
    type: "array",
    items: { type: "integer", minimum: 0, maximum: 6 },
    minItems: 1,
    maxItems: 7,
  },
  dayOfMonth: { type: "integer", minimum: 1, maximum: 31 },
  timeZone: scheduleTextField(100),
} satisfies Record<string, ToolNormalInvocationPropertyInput>;

export const scheduleDetailProperties = {
  title: scheduleTextField(200),
  prompt: { type: "string", minLength: 1 },
} satisfies Record<string, ToolNormalInvocationPropertyInput>;
