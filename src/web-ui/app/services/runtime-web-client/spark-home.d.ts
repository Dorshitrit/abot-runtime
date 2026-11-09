import type { SparkHomeSettingsSnapshot, SparkHomeSettingsUpdate } from "../../../../runtime/spark-home/settings/contracts.js";
import type { SparkHomeCalibrationInput, SparkHomeCalibrationDraftInput, SparkHomeCalibrationOptions, SparkHomeCalibrationDraft } from "../../../../runtime/spark-home/calibration/contracts.js";
import type { SparkHomeRunSnapshot, SparkHomeStartInput, SparkHomeReadRunInput, SparkHomeCancelInput, SparkHomeApprovalDecisionInput } from "../../../../runtime/spark-home/generation/contracts.js";
import type { SparkHomePreferences, SparkHomePreferencesUpdate } from "../../../../runtime/spark-home/preferences.js";
import type { SystemMetricsSnapshot } from "../../../system-metrics/contracts.js";

export interface SparkHomeScreen { revision: number; updatedAt: string; }
export declare function createSparkHomeRequests(options: {
  requestApi: (path: string, options?: RequestInit) => Promise<any>;
  resolveApiPath: (path: string) => string;
  getEnvironmentId: () => string;
  getConfig: () => Record<string, unknown> | null;
}): SparkHomeRequests;
export interface SparkHomeRequests {
  getSparkHome(environmentId?: string): Promise<{ ok: true; screen: SparkHomeScreen | null }>;
  getSystemMetrics(environmentId?: string, options?: { signal?: AbortSignal }): Promise<{ ok: true; metrics: SystemMetricsSnapshot }>;
  sparkHomeContentUrl(revision: number, environmentId?: string): string;
  getSparkHomeSettings(environmentId?: string): Promise<{ ok: true; settings: SparkHomeSettingsSnapshot }>;
  configureSparkHomeSettings(input: SparkHomeSettingsUpdate, environmentId?: string): Promise<{ ok: true; settings: SparkHomeSettingsSnapshot }>;
  getSparkHomePreferences(environmentId?: string): Promise<{ ok: true; preferences: SparkHomePreferences }>;
  configureSparkHomePreferences(input: SparkHomePreferencesUpdate, environmentId?: string): Promise<{ ok: true; preferences: SparkHomePreferences }>;
  getSparkHomeCalibrationOptions(input: SparkHomeCalibrationInput, environmentId?: string): Promise<{ ok: true; calibration: SparkHomeCalibrationOptions }>;
  draftSparkHomeInstructions(input: SparkHomeCalibrationDraftInput, environmentId?: string): Promise<{ ok: true; draft: SparkHomeCalibrationDraft }>;
  startSparkHomeRun(input: SparkHomeStartInput, environmentId?: string): Promise<{ ok: true; run: SparkHomeRunSnapshot }>;
  getSparkHomeRun(input?: SparkHomeReadRunInput, environmentId?: string): Promise<{ ok: true; run: SparkHomeRunSnapshot | null }>;
  cancelSparkHomeRun(input: SparkHomeCancelInput, environmentId?: string): Promise<{ ok: true; run: SparkHomeRunSnapshot }>;
  decideSparkHomeApproval(input: SparkHomeApprovalDecisionInput, environmentId?: string): Promise<{ ok: true; run: SparkHomeRunSnapshot }>;
}
