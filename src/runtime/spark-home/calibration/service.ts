import { isDeepStrictEqual } from "node:util";
import type { ModelGatewayClient, RuntimeConfig, ToolPermissionMode, ToolRegistry } from "../../ports.js";
import { resolveModelSelection } from "../../model/model-selection.js";
import { resolveSparkHomeModel } from "../settings/model-eligibility.js";
import { settingsFailure } from "../settings/contracts.js";
import type { StoredSparkHomeSettings } from "../settings/store.js";
import { readSparkHomeCalibrationOptions, assertAvailableSparkHomeCalibrationOptions } from "./options.js";
import { draftSparkHomeCalibration } from "./model.js";
import { parseSparkHomeCalibrationInput, parseSparkHomeCalibrationDraftInput,
  type SparkHomeCalibrationInput, type SparkHomeCalibrationDraftInput,
  type SparkHomeCalibrationOptions, type SparkHomeCalibrationDraft } from "./contracts.js";

export type SparkHomeCalibrationDependencies = Readonly<{
  tools: ToolRegistry; models: ModelGatewayClient;
  getSparkToolPermissionMode(): Promise<ToolPermissionMode>;
}>;

export function createSparkHomeCalibrationService(options: {
  config: RuntimeConfig; readSettings(): Promise<StoredSparkHomeSettings>;
  getSparkModelProfileId(): Promise<string | null>;
  dependencies?: SparkHomeCalibrationDependencies;
}) {
  let drafting = false;
  async function capture(input: SparkHomeCalibrationInput) {
    const dependencies = options.dependencies;
    if (!dependencies) return settingsFailure("spark_home_calibration_unavailable");
    const settings = await options.readSettings();
    if (settings.revision !== input.expectedRevision) return settingsFailure("spark_home_settings_conflict");
    const profileId = resolveSparkHomeModel(options.config, await options.getSparkModelProfileId(), input.modelProfileId);
    const selection = resolveModelSelection({ agentMode: "reasoning", modelPreference: { profileId, scope: "all" },
      modelPolicy: options.config.models, modelExecutionPolicies: options.config.modelExecutionPolicies });
    const toolPermissionMode = await dependencies.getSparkToolPermissionMode();
    const modelPlugins = selection.execution.plugins;
    const choices = readSparkHomeCalibrationOptions({ tools: dependencies.tools, toolPermissionMode, modelPlugins });
    return Object.freeze({ authority: { toolPermissionMode, modelPlugins }, public: Object.freeze({
      settingsRevision: settings.revision, effectiveModelProfileId: profileId, options: choices,
    }) });
  }
  return Object.freeze({
    async readOptions(input: SparkHomeCalibrationInput): Promise<SparkHomeCalibrationOptions> {
      return (await capture(parseSparkHomeCalibrationInput(input))).public;
    },
    async draft(input: SparkHomeCalibrationDraftInput, abortSignal?: AbortSignal): Promise<SparkHomeCalibrationDraft> {
      abortSignal?.throwIfAborted();
      const parsed = parseSparkHomeCalibrationDraftInput(input);
      if (drafting) return settingsFailure("spark_home_calibration_busy");
      drafting = true;
      try {
        const captured = await capture(parsed);
        abortSignal?.throwIfAborted();
        const binding = captured.public;
        assertAvailableSparkHomeCalibrationOptions(parsed.widgetIds, binding.options);
        const personalInstructions = await draftSparkHomeCalibration({ config: options.config,
          models: options.dependencies!.models, input: parsed, binding, abortSignal });
        const current = await capture(parsed);
        abortSignal?.throwIfAborted();
        if (!isDeepStrictEqual(captured, current)) return settingsFailure("spark_home_calibration_options_changed");
        return Object.freeze({ settingsRevision: binding.settingsRevision,
          effectiveModelProfileId: binding.effectiveModelProfileId, personalInstructions });
      } finally { drafting = false; }
    },
  });
}
