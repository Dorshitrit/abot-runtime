import { redactSecretText } from "./secret-text.js";

/** Protect the complete observed message before transport or model projection. */
export function protectObservedError(error: unknown, fallback: string): string {
  try {
    return redactSecretText(error instanceof Error ? error.message : fallback);
  } catch {
    return "Observed error details withheld because the protection check failed.";
  }
}
