export const STRUCTURED_DECISION_ENVELOPE_KEY = "decision" as const;

export function createStructuredDecisionEnvelopeSchema(
  variants: readonly Record<string, unknown>[],
): Record<string, unknown> {
  if (variants.length === 0) {
    throw new Error("structured_decision_variants_empty");
  }
  return {
    type: "object",
    properties: {
      [STRUCTURED_DECISION_ENVELOPE_KEY]:
        variants.length === 1
          ? variants[0]!
          : {
              anyOf: [...variants],
            },
    },
    required: [STRUCTURED_DECISION_ENVELOPE_KEY],
    additionalProperties: false,
  };
}

export function structuredDecisionVariantSchemaPath(
  index: number,
  variantCount: number,
): string {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    !Number.isInteger(variantCount) ||
    variantCount < 1 ||
    index >= variantCount
  ) {
    throw new Error("structured_decision_variant_path_invalid");
  }
  const decisionPath = `/properties/${STRUCTURED_DECISION_ENVELOPE_KEY}`;
  return variantCount === 1 ? decisionPath : `${decisionPath}/anyOf/${index}`;
}

export function readStructuredDecisionEnvelope(
  value: unknown,
): Record<string, unknown> | undefined {
  const envelope = asRecord(value);
  if (
    !envelope ||
    Object.keys(envelope).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(
      envelope,
      STRUCTURED_DECISION_ENVELOPE_KEY,
    )
  ) {
    return undefined;
  }
  return asRecord(envelope[STRUCTURED_DECISION_ENVELOPE_KEY]);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : undefined;
}
