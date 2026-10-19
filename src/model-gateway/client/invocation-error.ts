export type ModelGatewayInvocationFailureKind =
  | "network"
  | "http"
  | "stream"
  | "inactivity"
  | "missing_stream";

/** A failed transport attempt, distinct from local validation or callbacks. */
export class ModelGatewayInvocationError extends Error {
  constructor(
    readonly kind: ModelGatewayInvocationFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelGatewayInvocationError";
  }
}

export function wrapModelGatewayTransportError(
  kind: "network" | "stream",
  cause: unknown,
): ModelGatewayInvocationError {
  return new ModelGatewayInvocationError(
    kind,
    readTransportFailureMessage(kind, cause),
    { cause },
  );
}

function readTransportFailureMessage(
  kind: "network" | "stream",
  cause: unknown,
): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return `model_gateway_${kind}_failed`;
}

/** Only fetch rejection is classified; request construction stays with callers. */
export async function fetchModelGatewayResponse(
  url: string,
  init: RequestInit,
  abortSignal: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error: unknown) {
    if (abortSignal.aborted) throw error;
    throw wrapModelGatewayTransportError("network", error);
  }
}
