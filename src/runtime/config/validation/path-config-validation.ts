import { PATH_CONFIG_FIELDS } from "../fields.js";
import { validateOptionalString } from "./runtime-config-field-validation.js";

export function validatePathConfigRecord(
  issues: string[],
  paths: Record<string, unknown>,
  displayKey: string,
): void {
  for (const field of PATH_CONFIG_FIELDS) {
    validateOptionalString(
      issues,
      paths,
      field.key,
      `${displayKey}.${field.key}`,
    );
  }
}
