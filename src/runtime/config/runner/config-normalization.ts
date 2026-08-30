import {
  REQUEST_INVOKED_STEP_IDS,
  type RequestContextConfig,
  type RequestRunnerConfig,
  type RequestStepConfig,
} from "./contracts.js";
import { loadRequestStepInstructionBlocks } from "./instruction-refs.js";
import {
  invalidRuntimeConfig,
  requireConfigRecord,
  requireConfigString,
  requireExactConfigKeys,
  requirePositiveConfigInteger,
} from "./validation.js";

export type ParsedModelDefaults = Readonly<{
  profileId: string;
  rawStepTargets: Record<string, unknown>;
}>;

type MaterializeStepParams = Readonly<{
  configPath: string;
  defaultTimeoutMs: number;
  rawSteps: Record<string, unknown>;
  requireConfiguredTimeout: boolean;
}>;

const registeredStepIds = new Set<string>(REQUEST_INVOKED_STEP_IDS);

export function assertRegisteredModelStepKeys(
  value: Record<string, unknown>,
  configPath: string,
  field: string,
): void {
  for (const stepId of Object.keys(value)) {
    if (registeredStepIds.has(stepId)) {
      continue;
    }
    throw invalidRuntimeConfig(
      configPath,
      field + " contains unregistered model step " + stepId,
    );
  }
}

export function parseRequestRunnerModelDefaults(
  root: Record<string, unknown>,
  configPath: string,
): ParsedModelDefaults {
  const models = requireConfigRecord(root.models, configPath, "models");
  requireExactConfigKeys(models, ["defaults"], configPath, "models");
  const defaults = requireConfigRecord(
    models.defaults,
    configPath,
    "models.defaults",
  );
  requireExactConfigKeys(
    defaults,
    ["profileId", "steps"],
    configPath,
    "models.defaults",
  );
  const rawStepTargets = requireConfigRecord(
    defaults.steps,
    configPath,
    "models.defaults.steps",
  );
  assertRegisteredModelStepKeys(
    rawStepTargets,
    configPath,
    "models.defaults.steps",
  );
  return {
    profileId: requireConfigString(
      defaults.profileId,
      configPath,
      "models.defaults.profileId",
    ),
    rawStepTargets,
  };
}

export function parseRequestRunnerContext(
  root: Record<string, unknown>,
  configPath: string,
): RequestContextConfig {
  const rawContext = requireConfigRecord(root.context, configPath, "context");
  requireExactConfigKeys(
    rawContext,
    ["outputReserveTokens", "safetyReserveTokens", "attachmentReserveTokens"],
    configPath,
    "context",
  );
  return {
    outputReserveTokens: requirePositiveConfigInteger(
      rawContext.outputReserveTokens,
      configPath,
      "context.outputReserveTokens",
    ),
    safetyReserveTokens: requirePositiveConfigInteger(
      rawContext.safetyReserveTokens,
      configPath,
      "context.safetyReserveTokens",
    ),
    attachmentReserveTokens: requirePositiveConfigInteger(
      rawContext.attachmentReserveTokens,
      configPath,
      "context.attachmentReserveTokens",
    ),
  };
}

function materializeModelStepTargets(
  rawStepTargets: Record<string, unknown>,
  configPath: string,
): Record<string, string> {
  return Object.fromEntries(
    REQUEST_INVOKED_STEP_IDS.map((stepId) => [
      stepId,
      Object.hasOwn(rawStepTargets, stepId)
        ? requireConfigString(
            rawStepTargets[stepId],
            configPath,
            "models.defaults.steps." + stepId,
          )
        : stepId,
    ]),
  );
}

function assertRequestStepFields(
  step: Record<string, unknown>,
  configPath: string,
  field: string,
): void {
  for (const key of Object.keys(step)) {
    if (key === "timeoutMs" || key === "instructionRefs") {
      continue;
    }
    throw invalidRuntimeConfig(
      configPath,
      field + " may contain only: timeoutMs, instructionRefs",
    );
  }
}

function legacyStepOmitsRequiredTimeout(
  params: MaterializeStepParams,
  hasTimeout: boolean,
): boolean {
  return params.requireConfiguredTimeout && !hasTimeout;
}

function sparseStepOverrideIsEmpty(
  params: MaterializeStepParams,
  hasTimeout: boolean,
  hasInstructionRefs: boolean,
): boolean {
  return !params.requireConfiguredTimeout && !hasTimeout && !hasInstructionRefs;
}

function materializeRequestStep(
  stepId: string,
  params: MaterializeStepParams,
): RequestStepConfig {
  const rawStep = params.rawSteps[stepId];
  if (rawStep === undefined) {
    return { timeoutMs: params.defaultTimeoutMs };
  }
  const field = "steps." + stepId;
  const step = requireConfigRecord(rawStep, params.configPath, field);
  assertRequestStepFields(step, params.configPath, field);
  const hasTimeout = Object.hasOwn(step, "timeoutMs");
  const hasInstructionRefs = Object.hasOwn(step, "instructionRefs");
  if (legacyStepOmitsRequiredTimeout(params, hasTimeout)) {
    throw invalidRuntimeConfig(
      params.configPath,
      field + ".timeoutMs is required by the legacy v1 format",
    );
  }
  if (sparseStepOverrideIsEmpty(params, hasTimeout, hasInstructionRefs)) {
    throw invalidRuntimeConfig(
      params.configPath,
      field + " must override timeoutMs or instructionRefs",
    );
  }
  return {
    timeoutMs: hasTimeout
      ? requirePositiveConfigInteger(
          step.timeoutMs,
          params.configPath,
          field + ".timeoutMs",
        )
      : params.defaultTimeoutMs,
    ...(hasInstructionRefs
      ? {
          instructionBlocks: loadRequestStepInstructionBlocks({
            configPath: params.configPath,
            stepId,
            rawRefs: step.instructionRefs,
          }),
        }
      : {}),
  };
}

function materializeRequestSteps(
  params: MaterializeStepParams,
): Record<string, RequestStepConfig> {
  return Object.fromEntries(
    REQUEST_INVOKED_STEP_IDS.map((stepId) => [
      stepId,
      materializeRequestStep(stepId, params),
    ]),
  );
}

export function materializeRequestRunnerConfig(params: {
  configPath: string;
  context: RequestContextConfig;
  defaultTimeoutMs: number;
  modelDefaults: ParsedModelDefaults;
  rawSteps: Record<string, unknown>;
  requireConfiguredTimeout: boolean;
}): RequestRunnerConfig {
  return {
    models: {
      defaults: {
        profileId: params.modelDefaults.profileId,
        steps: materializeModelStepTargets(
          params.modelDefaults.rawStepTargets,
          params.configPath,
        ),
      },
    },
    context: params.context,
    steps: materializeRequestSteps({
      configPath: params.configPath,
      defaultTimeoutMs: params.defaultTimeoutMs,
      rawSteps: params.rawSteps,
      requireConfiguredTimeout: params.requireConfiguredTimeout,
    }),
  };
}
