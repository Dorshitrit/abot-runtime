import { textOf } from "../../lib/text-format.js";

export function validateContextWindowTokens(value) {
  const tokens = Number(textOf(value).trim());
  if (!Number.isSafeInteger(tokens) || tokens <= 0)
    return {
      valid: false,
      field: "context-window",
      message:
        "Enter a context window as a positive whole number of tokens within the safe numeric range.",
    };
  return { valid: true, value: tokens };
}

export function formatContextWindowTokens(value) {
  const context = validateContextWindowTokens(value);
  return context.valid ? `${context.value.toLocaleString("en-US")} tokens` : "";
}
