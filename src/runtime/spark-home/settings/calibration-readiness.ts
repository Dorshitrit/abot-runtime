import { settingsFailure } from "./contracts.js";
import type { SparkHomeRequestSettings } from "./contracts.js";

export function hasSavedSparkHomeCalibration(settings: { personalInstructions: string }): boolean {
  return settings.personalInstructions.trim().length > 0;
}

export function assertSavedSparkHomeCalibration(settings: { personalInstructions: string }): void {
  if (!hasSavedSparkHomeCalibration(settings)) settingsFailure("spark_home_calibration_required");
}

/** Local owner-only admission; the callback is never exposed over RPC. */
export type SparkHomeCalibrationAdmission = <T>(action: (settings: SparkHomeRequestSettings) => Promise<T>) => Promise<T>;
