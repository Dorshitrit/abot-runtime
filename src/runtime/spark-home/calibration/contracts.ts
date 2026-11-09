import { settingsFailure } from "../settings/contracts.js";
import type { SparkHomeCalibrationOption } from "./options.js";

export type SparkHomeCalibrationInput = Readonly<{
  expectedRevision: number; modelProfileId: string | null;
}>;
export type SparkHomeCalibrationDraftInput = SparkHomeCalibrationInput & Readonly<{
  widgetIds: readonly string[]; topics: string; constraints: string;
}>;
export type SparkHomeCalibrationOptions = Readonly<{
  settingsRevision: number; effectiveModelProfileId: string;
  options: readonly SparkHomeCalibrationOption[];
}>;
export type SparkHomeCalibrationDraft = Readonly<{
  settingsRevision: number; effectiveModelProfileId: string; personalInstructions: string;
}>;

function requireCalibrationRecord(value: unknown, draft: boolean): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return settingsFailure("spark_home_calibration_invalid");
  const input = value as Record<string, unknown>;
  const fields = ["expectedRevision", "modelProfileId", ...(draft ? ["widgetIds", "topics", "constraints"] : [])];
  if (Object.keys(input).some(key => !fields.includes(key))) return settingsFailure("spark_home_calibration_invalid");
  return input;
}
function readCalibrationBinding(input: Record<string, unknown>): SparkHomeCalibrationInput {
  if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0)
    return settingsFailure("spark_home_calibration_invalid");
  if (input.modelProfileId !== null && (typeof input.modelProfileId !== "string" || !input.modelProfileId.trim() || input.modelProfileId.length > 256))
    return settingsFailure("spark_home_calibration_invalid");
  return Object.freeze({ expectedRevision: Number(input.expectedRevision), modelProfileId: input.modelProfileId as string | null });
}
export function parseSparkHomeCalibrationInput(value: unknown): SparkHomeCalibrationInput {
  return readCalibrationBinding(requireCalibrationRecord(value, false));
}
export function parseSparkHomeCalibrationDraftInput(value: unknown): SparkHomeCalibrationDraftInput {
  const input = requireCalibrationRecord(value, true);
  const binding = readCalibrationBinding(input);
  if (!Array.isArray(input.widgetIds) || input.widgetIds.length > 4 ||
      input.widgetIds.some(id => typeof id !== "string" || id.length > 64) || new Set(input.widgetIds).size !== input.widgetIds.length)
    return settingsFailure("spark_home_calibration_invalid");
  if (typeof input.topics !== "string" || input.topics.length > 1000 || typeof input.constraints !== "string" || input.constraints.length > 1000)
    return settingsFailure("spark_home_calibration_invalid");
  if (!input.widgetIds.length && !input.topics.trim() && !input.constraints.trim()) return settingsFailure("spark_home_calibration_empty");
  return Object.freeze({ ...binding, widgetIds: Object.freeze([...input.widgetIds]) as readonly string[],
    topics: input.topics, constraints: input.constraints });
}
