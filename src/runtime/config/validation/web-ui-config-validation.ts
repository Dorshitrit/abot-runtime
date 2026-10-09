import type { RuntimeConfigFile } from "../types.js";
import {
  validateOptionalBoolean,
  validateOptionalPositiveInteger,
  validateOptionalObject,
} from "./runtime-config-field-validation.js";
import { RuntimeConfigValidationError } from "./runtime-config-validation-contract.js";

function isUnsupportedWebUiField(key: string): boolean {
  return !["openOnRuntimeServiceStart", "pageSize"].includes(key);
}

function validateWebUiConfig(
  issues: string[],
  webUi: Record<string, unknown>,
): void {
  validateOptionalBoolean(
    issues,
    webUi,
    "openOnRuntimeServiceStart",
    "webUi.openOnRuntimeServiceStart",
  );
  validateOptionalPositiveInteger(issues, webUi, "pageSize", "webUi.pageSize");
  for (const key of Object.keys(webUi)) {
    if (isUnsupportedWebUiField(key)) {
      issues.push(`webUi.${key} is not a supported configuration field`);
    }
  }
}

export function validateWebUiConfigSection(
  issues: string[],
  config: Record<string, unknown>,
): void {
  const webUi = validateOptionalObject(issues, config, "webUi");
  if (webUi) {
    validateWebUiConfig(issues, webUi);
  }
}

export function validateRuntimeWebUiConfig(
  config: RuntimeConfigFile,
  configPath: string,
): void {
  const issues: string[] = [];
  validateWebUiConfigSection(issues, config as Record<string, unknown>);
  if (issues.length > 0) {
    throw new RuntimeConfigValidationError(configPath, issues);
  }
}
