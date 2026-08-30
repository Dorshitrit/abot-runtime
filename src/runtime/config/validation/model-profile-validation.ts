import {
  isRequestExecutionPolicyId,
  REQUEST_EXECUTION_POLICY_IDS,
} from "../model-execution-policy.js";
import { hasOwnValue, isRecord } from "../utils.js";
import {
  validateModelContextConfig,
  validateModelGenerationConfig,
} from "./model-invocation-config-validation.js";
import { validateOptionalModelCalibrations } from "./model-invocation-override-validation.js";
import {
  validateOptionalBoolean,
  validateOptionalModelModalityArray,
  validateOptionalObject,
  validateOptionalPositiveInteger,
  validateOptionalSetupString,
  validateOptionalString,
} from "./runtime-config-field-validation.js";

function hasUnsafeContextWindowTokenCount(
  profile: Record<string, unknown>,
): boolean {
  if (!hasOwnValue(profile, "contextWindowTokens")) {
    return false;
  }
  if (typeof profile.contextWindowTokens !== "number") {
    return false;
  }
  return !Number.isSafeInteger(profile.contextWindowTokens);
}

function validateRequiredModelReference(
  issues: string[],
  profile: Record<string, unknown>,
  displayKey: string,
  allowConfigRef: boolean,
): void {
  const modelIsMissing = !hasOwnValue(profile, "model");
  const configRefIsMissing = !hasOwnValue(profile, "configRef");
  const modelOrConfigRefIsRequired =
    allowConfigRef && modelIsMissing && configRefIsMissing;
  if (modelOrConfigRefIsRequired) {
    issues.push(`${displayKey}.model or configRef must be provided`);
  }

  const directModelIsRequired = !allowConfigRef && modelIsMissing;
  if (directModelIsRequired) {
    issues.push(`${displayKey}.model must be provided`);
  }
}

function validateRequiredContextWindowTokens(
  issues: string[],
  profile: Record<string, unknown>,
  displayKey: string,
  allowConfigRef: boolean,
): void {
  const configRefProvidesProfileDefinition =
    allowConfigRef && hasOwnValue(profile, "configRef");
  const contextWindowTokensAreMissing = !hasOwnValue(
    profile,
    "contextWindowTokens",
  );
  if (!configRefProvidesProfileDefinition && contextWindowTokensAreMissing) {
    issues.push(`${displayKey}.contextWindowTokens must be provided`);
  }
}

function validateRequiredModelProfileFields(
  issues: string[],
  profile: Record<string, unknown>,
  displayKey: string,
  allowConfigRef: boolean,
  allowIncompleteSetup: boolean | undefined,
): void {
  if (allowIncompleteSetup) {
    return;
  }
  validateRequiredModelReference(issues, profile, displayKey, allowConfigRef);
  validateRequiredContextWindowTokens(
    issues,
    profile,
    displayKey,
    allowConfigRef,
  );
}

function validateModelProfileCapabilities(
  issues: string[],
  capabilities: Record<string, unknown>,
  displayKey: string,
): void {
  validateOptionalModelModalityArray(
    issues,
    capabilities,
    "inputModalities",
    `${displayKey}.inputModalities`,
  );
  validateOptionalModelModalityArray(
    issues,
    capabilities,
    "outputModalities",
    `${displayKey}.outputModalities`,
  );
}

function validateModelExecutionPolicy(
  issues: string[],
  execution: Record<string, unknown>,
  displayKey: string,
): void {
  const hasUnsupportedExecutionField = Object.keys(execution).some(
    (key) => key !== "policy",
  );
  if (hasUnsupportedExecutionField) {
    issues.push(`${displayKey} may contain only: policy`);
  }
  const hasUnsupportedExecutionPolicy =
    hasOwnValue(execution, "policy") &&
    !isRequestExecutionPolicyId(execution.policy);
  if (hasUnsupportedExecutionPolicy) {
    issues.push(
      `${displayKey}.policy must be one of: ${REQUEST_EXECUTION_POLICY_IDS.join(", ")}`,
    );
  }
}

export function validateModelProfileConfig(
  issues: string[],
  profile: Record<string, unknown>,
  displayKey: string,
  options: {
    allowConfigRef: boolean;
    allowIncompleteSetup?: boolean;
  } = { allowConfigRef: true },
): void {
  validateOptionalSetupString(
    issues,
    profile,
    "configRef",
    `${displayKey}.configRef`,
    options.allowIncompleteSetup === true,
  );
  validateOptionalString(issues, profile, "label", `${displayKey}.label`);
  validateOptionalSetupString(
    issues,
    profile,
    "provider",
    `${displayKey}.provider`,
    options.allowIncompleteSetup === true,
  );
  validateOptionalSetupString(
    issues,
    profile,
    "model",
    `${displayKey}.model`,
    options.allowIncompleteSetup === true,
  );
  validateOptionalPositiveInteger(
    issues,
    profile,
    "contextWindowTokens",
    `${displayKey}.contextWindowTokens`,
  );
  if (hasUnsafeContextWindowTokenCount(profile)) {
    issues.push(`${displayKey}.contextWindowTokens must be a safe integer`);
  }
  validateRequiredModelProfileFields(
    issues,
    profile,
    displayKey,
    options.allowConfigRef,
    options.allowIncompleteSetup,
  );
  validateOptionalBoolean(
    issues,
    profile,
    "supportsThinking",
    `${displayKey}.supportsThinking`,
  );
  if (hasOwnValue(profile, "options") && !isRecord(profile.options)) {
    issues.push(`${displayKey}.options must be an object`);
  }

  const capabilities = validateOptionalObject(
    issues,
    profile,
    "capabilities",
    `${displayKey}.capabilities`,
  );
  if (capabilities) {
    validateModelProfileCapabilities(
      issues,
      capabilities,
      `${displayKey}.capabilities`,
    );
  }

  const generation = validateOptionalObject(
    issues,
    profile,
    "generation",
    `${displayKey}.generation`,
  );
  if (generation) {
    validateModelGenerationConfig(
      issues,
      generation,
      `${displayKey}.generation`,
    );
  }

  const context = validateOptionalObject(
    issues,
    profile,
    "context",
    `${displayKey}.context`,
  );
  if (context) {
    validateModelContextConfig(issues, context, `${displayKey}.context`);
  }

  const execution = validateOptionalObject(
    issues,
    profile,
    "execution",
    `${displayKey}.execution`,
  );
  if (execution) {
    validateModelExecutionPolicy(issues, execution, `${displayKey}.execution`);
  }

  validateOptionalModelCalibrations(
    issues,
    profile,
    "calibration",
    `${displayKey}.calibration`,
  );
}
