import { hasOwnValue } from "../utils.js";
import {
  validateOptionalNonNegativeInteger,
  validateOptionalNumber,
  validateOptionalObject,
  validateOptionalPositiveNumber,
} from "./runtime-config-field-validation.js";

const SUPPORTED_MODEL_REASONING_EFFORTS = new Set<unknown>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function validateFormatTokenAccounting(
  issues: string[],
  formatTokenAccounting: Record<string, unknown>,
  displayKey: string,
): void {
  const modeIsSupported =
    formatTokenAccounting.mode === "none" ||
    formatTokenAccounting.mode === "estimate";
  if (!modeIsSupported) {
    issues.push(`${displayKey}.mode must be none or estimate`);
  }
  validateOptionalNonNegativeInteger(
    issues,
    formatTokenAccounting,
    "fixedOverheadTokens",
    `${displayKey}.fixedOverheadTokens`,
  );
}

function validateTokenEstimation(
  issues: string[],
  tokenEstimation: Record<string, unknown>,
  displayKey: string,
): void {
  validateOptionalPositiveNumber(
    issues,
    tokenEstimation,
    "asciiCharactersPerToken",
    `${displayKey}.asciiCharactersPerToken`,
  );
  validateOptionalPositiveNumber(
    issues,
    tokenEstimation,
    "nonAsciiBytesPerToken",
    `${displayKey}.nonAsciiBytesPerToken`,
  );
  validateOptionalPositiveNumber(
    issues,
    tokenEstimation,
    "messageOverheadTokens",
    `${displayKey}.messageOverheadTokens`,
  );
}

function hasUnsupportedReasoningEffort(
  generation: Record<string, unknown>,
): boolean {
  if (!hasOwnValue(generation, "reasoningEffort")) {
    return false;
  }
  return !SUPPORTED_MODEL_REASONING_EFFORTS.has(generation.reasoningEffort);
}

export function validateModelContextConfig(
  issues: string[],
  context: Record<string, unknown>,
  displayKey: string,
): void {
  if (hasOwnValue(context, "maxInputTokens")) {
    issues.push(
      `${displayKey}.maxInputTokens is not supported; declare contextWindowTokens on the model profile`,
    );
  }
  if (hasOwnValue(context, "maxConversationMessages")) {
    issues.push(
      `${displayKey}.maxConversationMessages is not supported; current-session history is managed by runtime session memory`,
    );
  }
  if (hasOwnValue(context, "maxToolObservationMessages")) {
    issues.push(
      `${displayKey}.maxToolObservationMessages is not supported; tool observations are projected by their owning context contract`,
    );
  }

  const formatTokenAccounting = validateOptionalObject(
    issues,
    context,
    "formatTokenAccounting",
    `${displayKey}.formatTokenAccounting`,
  );
  if (formatTokenAccounting) {
    validateFormatTokenAccounting(
      issues,
      formatTokenAccounting,
      `${displayKey}.formatTokenAccounting`,
    );
  }

  if (hasOwnValue(context, "artifactContextMode")) {
    issues.push(
      `${displayKey}.artifactContextMode is not supported; artifact projection is owned by the capability context contract`,
    );
  }

  const tokenEstimation = validateOptionalObject(
    issues,
    context,
    "tokenEstimation",
    `${displayKey}.tokenEstimation`,
  );
  if (tokenEstimation) {
    validateTokenEstimation(
      issues,
      tokenEstimation,
      `${displayKey}.tokenEstimation`,
    );
  }

  if (hasOwnValue(context, "compaction")) {
    issues.push(
      `${displayKey}.compaction is not supported; context compaction uses the runtime-owned 70 percent trigger`,
    );
  }
}

export function validateModelGenerationConfig(
  issues: string[],
  generation: Record<string, unknown>,
  displayKey: string,
): void {
  if (hasOwnValue(generation, "maxOutputTokens")) {
    issues.push(
      `${displayKey}.maxOutputTokens is not supported; remove it and let the provider enforce physical output capacity`,
    );
  }
  validateOptionalNumber(
    issues,
    generation,
    "temperature",
    `${displayKey}.temperature`,
  );
  validateOptionalNumber(issues, generation, "topP", `${displayKey}.topP`);
  if (hasUnsupportedReasoningEffort(generation)) {
    issues.push(
      `${displayKey}.reasoningEffort must be none, minimal, low, medium, high, or xhigh`,
    );
  }
}
