import { sanitizeJsonText } from "../../../src/plugin-sdk/index.js";

/** Encodes untrusted text onto one JSON-safe logical line. */
export function quoteUntrusted(value: string): string {
  return JSON.stringify(sanitizeJsonText(value))
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}
