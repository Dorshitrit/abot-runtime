/** Gateway-owned metadata; never copied from upstream headers or error text. */
export const PROVIDER_STREAM_DISCONNECTION = "provider_stream_disconnection_v1";
export const PROVIDER_STREAM_DISCONNECTION_HEADER = "x-abot-model-stream-disconnection";
export type ProviderStreamDisconnection = typeof PROVIDER_STREAM_DISCONNECTION;

/** Content-free evidence that the provider adapter observed a disconnected stream. */
export class ProviderStreamDisconnectionError extends Error {
  readonly code = "model_provider_stream_disconnected";

  constructor() {
    super("model_provider_stream_disconnected");
    this.name = "ProviderStreamDisconnectionError";
  }
}

export function providerStreamDisconnectionCause(value: unknown): ErrorOptions | undefined {
  if (value !== PROVIDER_STREAM_DISCONNECTION) return undefined;
  return { cause: new ProviderStreamDisconnectionError() };
}

/** Only typed causes establish provenance; messages and lookalike objects never do. */
export function isProviderStreamDisconnectionError(error: unknown): boolean {
  const seen = new Set<Error>();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(current instanceof Error)) return false;
    if (seen.has(current)) return false;
    if (current instanceof ProviderStreamDisconnectionError) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}
