import { homeGenerationFailure, type SparkHomeStartInput, type SparkHomeReadRunInput,
  type SparkHomeCancelInput, type SparkHomeApprovalDecisionInput } from "./contracts.js";

function requireHomeInput(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return homeGenerationFailure("spark_home_request_invalid");
  if (Object.keys(value).some(key => !allowed.includes(key))) return homeGenerationFailure("spark_home_request_invalid");
  return value as Record<string, unknown>;
}
function requireHomeRunId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) return homeGenerationFailure("spark_home_run_id_invalid");
  return value;
}
export function parseSparkHomeStartInput(value: unknown): SparkHomeStartInput {
  const input = requireHomeInput(value, ["expectedSettingsRevision", "instruction"]);
  if (!Number.isSafeInteger(input.expectedSettingsRevision) || Number(input.expectedSettingsRevision) < 0)
    return homeGenerationFailure("spark_home_request_invalid");
  if (input.instruction !== undefined && (typeof input.instruction !== "string" || input.instruction.length > 4000))
    return homeGenerationFailure("spark_home_request_invalid");
  return { expectedSettingsRevision: Number(input.expectedSettingsRevision),
    ...(typeof input.instruction === "string" && input.instruction.trim() ? { instruction: input.instruction } : {}) };
}
export function parseSparkHomeReadRunInput(value: unknown = {}): SparkHomeReadRunInput {
  const input = requireHomeInput(value, ["runId"]);
  return input.runId === undefined ? {} : { runId: requireHomeRunId(input.runId) };
}
export function parseSparkHomeCancelInput(value: unknown): SparkHomeCancelInput {
  const input = requireHomeInput(value, ["runId"]);
  return { runId: requireHomeRunId(input.runId) };
}
export function parseSparkHomeApprovalDecisionInput(value: unknown): SparkHomeApprovalDecisionInput {
  const input = requireHomeInput(value, ["runId", "approvalId", "approved", "reason"]);
  if (typeof input.approved !== "boolean") return homeGenerationFailure("spark_home_approval_invalid");
  if (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > 2000))
    return homeGenerationFailure("spark_home_approval_invalid");
  return { runId: requireHomeRunId(input.runId), approvalId: requireHomeRunId(input.approvalId), approved: input.approved,
    ...(typeof input.reason === "string" && input.reason.trim() ? { reason: input.reason } : {}) };
}
