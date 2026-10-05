import type { ToolImplementationOutput } from "./tool-types.js";

/** Bounds receipt/metadata bytes; declared context text uses model admission. */
export const CAPABILITY_RESULT_ENVELOPE_MAX_BYTES = 256 * 1024;

export type ToolResultBudgetAssessment = Readonly<{
  fits: boolean;
  serializedBytes: number;
  envelopeBytes?: number;
  contextTextBytes?: number;
  maxBytes: number;
}>;

/** Bound by the host to this invocation's complete delivery envelope. */
export type ToolResultBudget = Readonly<{
  /** Host support for exact text admitted later by its existing context gate. */
  acceptsContextText?: true;
  assess(result: ToolImplementationOutput): ToolResultBudgetAssessment;
}>;

export function assessResultEnvelopeBytes(
  envelope: unknown,
  contextTextBytes = 0,
): ToolResultBudgetAssessment {
  const serialized = JSON.stringify(envelope);
  if (serialized === undefined)
    throw new TypeError("result_envelope_not_json_safe");
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  const envelopeBytes = serializedBytes - contextTextBytes;
  const hasValidEnvelopeAccounting =
    Number.isSafeInteger(contextTextBytes) &&
    contextTextBytes >= 0 &&
    envelopeBytes >= 0;
  if (!hasValidEnvelopeAccounting)
    throw new TypeError("result_envelope_accounting_invalid");
  return Object.freeze({
    fits: envelopeBytes <= CAPABILITY_RESULT_ENVELOPE_MAX_BYTES,
    serializedBytes,
    envelopeBytes,
    contextTextBytes,
    maxBytes: CAPABILITY_RESULT_ENVELOPE_MAX_BYTES,
  });
}
