import type { RuntimeConfig } from "../../ports.js";
import {
  parseSparkHomeSettingsUpdate, settingsFailure, SparkHomeSettingsError,
  type SparkHomeSettingsService, type SparkHomeSettingsSnapshot, type SparkHomeSettingsUpdate,
  type SparkHomeRequestSettings, type SparkHomeRequestPreparation,
} from "./contracts.js";
import { createSparkHomeSettingsStore, type StoredSparkHomeSettings } from "./store.js";
import { listSparkHomeModels, resolveSparkHomeModel } from "./model-eligibility.js";
import { assertSavedSparkHomeCalibration, hasSavedSparkHomeCalibration } from "./calibration-readiness.js";
import { createSparkHomeCalibrationService, type SparkHomeCalibrationDependencies } from "../calibration/service.js";

export type SparkHomeSettingsDependencies = Readonly<{
  runtimeDirectory: string;
  config: RuntimeConfig;
  getSparkModelProfileId(): Promise<string | null>;
  calibration?: SparkHomeCalibrationDependencies;
}>;

/** Manual HOME preferences and admission; legacy schedule fields are inert storage only. */
export function createSparkHomeSettingsService(options: SparkHomeSettingsDependencies): SparkHomeSettingsService {
  const store = createSparkHomeSettingsStore(options.runtimeDirectory);
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const result = tail.then(action);
    tail = result.catch(() => undefined);
    return result;
  }
  const calibration = createSparkHomeCalibrationService({ config: options.config,
    getSparkModelProfileId: options.getSparkModelProfileId, dependencies: options.calibration,
    readSettings: () => serial(store.read),
  });

  async function resolveCurrentHomeModel(settings: StoredSparkHomeSettings): Promise<string> {
    return resolveSparkHomeModel(options.config, await options.getSparkModelProfileId(), settings.modelProfileId);
  }

  async function projectSparkHomeSettings(settings: StoredSparkHomeSettings): Promise<SparkHomeSettingsSnapshot> {
    const sparkProfile = await options.getSparkModelProfileId();
    let effectiveModelProfileId: string | null = null;
    let reason: string | null = null;
    try { effectiveModelProfileId = resolveSparkHomeModel(options.config, sparkProfile, settings.modelProfileId); }
    catch (error) {
      if (!(error instanceof SparkHomeSettingsError)) throw error;
      reason = error.code;
    }
    return Object.freeze({
      revision: settings.revision, personalInstructions: settings.personalInstructions, modelProfileId: settings.modelProfileId,
      effectiveModelProfileId, available: reason === null, reason, calibrationRequired: !hasSavedSparkHomeCalibration(settings),
      models: listSparkHomeModels(options.config, sparkProfile), schedulingAvailable: false,
    });
  }

  async function captureSparkHomeAdmission(input?: SparkHomeRequestPreparation): Promise<SparkHomeRequestSettings> {
    input?.abortSignal?.throwIfAborted();
    const settings = await store.read();
    if (input?.expectedRevision !== undefined && settings.revision !== input.expectedRevision)
      return settingsFailure("spark_home_settings_conflict");
    const modelProfileId = await resolveCurrentHomeModel(settings);
    assertSavedSparkHomeCalibration(settings);
    input?.abortSignal?.throwIfAborted();
    return Object.freeze({ revision: settings.revision, personalInstructions: settings.personalInstructions,
      modelProfileId, executionPolicy: "execution-agent-v1" });
  }

  return Object.freeze({
    read: () => serial(async () => projectSparkHomeSettings(await store.read())),
    readCalibrationOptions: calibration.readOptions,
    draftCalibration: calibration.draft,
    withCalibrationReady: <T>(action: (current: SparkHomeRequestSettings) => Promise<T>): Promise<T> =>
      serial(async () => action(await captureSparkHomeAdmission())),
    prepareRequest: (input?: SparkHomeRequestPreparation) => serial(() => captureSparkHomeAdmission(input)),
    update: (value: SparkHomeSettingsUpdate) => serial(async () => {
      const input = parseSparkHomeSettingsUpdate(value);
      const previous = await store.read();
      if (previous.revision !== input.expectedRevision || previous.revision === Number.MAX_SAFE_INTEGER)
        return settingsFailure("spark_home_settings_conflict");
      const next: StoredSparkHomeSettings = { ...previous, revision: previous.revision + 1,
        personalInstructions: input.personalInstructions, modelProfileId: input.modelProfileId };
      if (next.modelProfileId !== null) await resolveCurrentHomeModel(next);
      await store.write(next);
      return projectSparkHomeSettings(next);
    }),
  });
}
