/** Gateway-owned metadata; never copied from an upstream header or error message. */
export const PROVIDER_CONTEXT_OVERFLOW = "provider_context_overflow_v1";
export const PROVIDER_CONTEXT_OVERFLOW_HEADER = "x-abot-model-context-overflow";
export type ProviderContextOverflow = typeof PROVIDER_CONTEXT_OVERFLOW;

/** A bounded, content-free cause carried by the existing transport error. */
export class ProviderContextOverflowError extends Error {
  readonly code = "model_provider_context_overflow";

  constructor() {
    super("model_provider_context_overflow");
    this.name = "ProviderContextOverflowError";
  }
}

export function readProviderContextOverflow(value: unknown): ProviderContextOverflow | undefined {
  return value === PROVIDER_CONTEXT_OVERFLOW ? PROVIDER_CONTEXT_OVERFLOW : undefined;
}

export function providerContextOverflowCause(value: unknown): ErrorOptions | undefined {
  if (!readProviderContextOverflow(value)) return undefined;
  return { cause: new ProviderContextOverflowError() };
}

/** Only typed causes establish provenance; messages and lookalike objects never do. */
export function isProviderContextOverflowError(error: unknown): boolean {
  const seen = new Set<Error>();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(current instanceof Error)) return false;
    if (seen.has(current)) return false;
    if (current instanceof ProviderContextOverflowError) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}
