import type { ToolPermissionMode } from "../../capabilities/tool-permission-mode.js";
import { SchedulerValidationError } from "./validation-error.js";

export type SchedulerToolPermissionMode = Extract<
  ToolPermissionMode,
  "full_access" | "full_plus"
>;

export function isSchedulerToolPermissionMode(
  value: unknown,
): value is SchedulerToolPermissionMode {
  if (value === "full_access") return true;
  return value === "full_plus";
}

/** Missing authority belongs to legacy Full jobs and runs; never upgrade it. */
export function requireSchedulerToolPermissionMode(
  value: unknown,
): SchedulerToolPermissionMode {
  if (value === undefined) return "full_access";
  if (isSchedulerToolPermissionMode(value)) return value;
  throw new SchedulerValidationError(
    "scheduler_invalid_job",
    "toolPermissionMode must be full_access or full_plus",
  );
}
