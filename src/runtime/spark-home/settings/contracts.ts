import type { SparkHomeCalibrationAdmission } from "./calibration-readiness.js";
import type { SparkHomeCalibrationInput, SparkHomeCalibrationDraftInput, SparkHomeCalibrationOptions, SparkHomeCalibrationDraft } from "../calibration/contracts.js";
import type { SparkHomeModelOption } from "./model-eligibility.js";

export type SparkHomeSettingsSnapshot = Readonly<{
  revision: number; personalInstructions: string; modelProfileId: string | null; calibrationRequired: boolean;
  effectiveModelProfileId: string | null; available: boolean; reason: string | null;
  models: readonly SparkHomeModelOption[];
  schedulingAvailable: false;
}>;
export type SparkHomeSettingsUpdate = Readonly<{
  expectedRevision: number;
  personalInstructions: string; modelProfileId: string | null;
}>;
export type SparkHomeRequestSettings = Readonly<{
  revision: number; personalInstructions: string; modelProfileId: string;
  executionPolicy: "execution-agent-v1";
}>;
export type SparkHomeRequestPreparation = Readonly<{ expectedRevision?: number; abortSignal?: AbortSignal }>;
export interface SparkHomeSettingsService {
  read(): Promise<SparkHomeSettingsSnapshot>;
  update(input: SparkHomeSettingsUpdate): Promise<SparkHomeSettingsSnapshot>;
  prepareRequest(input?: SparkHomeRequestPreparation): Promise<SparkHomeRequestSettings>;
  readCalibrationOptions(input: SparkHomeCalibrationInput): Promise<SparkHomeCalibrationOptions>;
  draftCalibration(input: SparkHomeCalibrationDraftInput, abortSignal?: AbortSignal): Promise<SparkHomeCalibrationDraft>;
  withCalibrationReady: SparkHomeCalibrationAdmission;
}
export class SparkHomeSettingsError extends Error {
  constructor(readonly code: string) { super(code); this.name = "SparkHomeSettingsError"; }
}
export function settingsFailure(code: string): never { throw new SparkHomeSettingsError(code); }

export function parseSparkHomeSettingsUpdate(value: unknown): SparkHomeSettingsUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return settingsFailure("spark_home_settings_invalid");
  const input = value as Record<string, unknown>;
  const allowed = ["expectedRevision", "personalInstructions", "modelProfileId"];
  if (Object.keys(input).some(key => !allowed.includes(key))) return settingsFailure("spark_home_settings_invalid");
  if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) return settingsFailure("spark_home_settings_invalid");
  if (typeof input.personalInstructions !== "string" || input.personalInstructions.length > 4000) return settingsFailure("spark_home_settings_invalid");
  if (input.modelProfileId !== null && (typeof input.modelProfileId !== "string" || !input.modelProfileId.trim() || input.modelProfileId.length > 256))
    return settingsFailure("spark_home_settings_invalid");
  return Object.freeze({ expectedRevision: Number(input.expectedRevision),
    personalInstructions: input.personalInstructions, modelProfileId: typeof input.modelProfileId === "string" ? input.modelProfileId.trim() : null });
}
