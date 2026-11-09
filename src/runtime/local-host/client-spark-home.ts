import type { LocalRuntimeCallHandler } from "./contracts.js";
import type { SparkHomeService } from "../spark-home/contracts.js";
import type { SparkHomeSettingsService } from "../spark-home/settings/contracts.js";
import type { SparkHomeGenerationService } from "../spark-home/generation/contracts.js";
import type { SparkHomePreferencesService } from "../spark-home/preferences.js";
import { LOCAL_HOME_METHODS } from "./app-spark-home-services.js";

export function createLocalSparkHomeClients(call: LocalRuntimeCallHandler) {
  function service<T>(name: keyof typeof LOCAL_HOME_METHODS): T {
    return Object.fromEntries(LOCAL_HOME_METHODS[name].map(method =>
      [method, (...args: unknown[]) => call(`${name}.${method}`, args)])) as T;
  }
  return {
    sparkHome: service<Pick<SparkHomeService, "read">>("sparkHome"),
    sparkHomeSettings: service<Pick<SparkHomeSettingsService,
      "read" | "update" | "readCalibrationOptions" | "draftCalibration">>("sparkHomeSettings"),
    sparkHomeGeneration: service<Pick<SparkHomeGenerationService,
      "start" | "readRun" | "cancel" | "decideApproval">>("sparkHomeGeneration"),
    sparkHomePreferences: service<SparkHomePreferencesService>("sparkHomePreferences"),
  };
}
