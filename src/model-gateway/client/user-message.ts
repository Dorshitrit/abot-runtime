import { readProviderUserErrorMessage } from "../protocol/provider-user-error.js";
import type { ModelGatewayInvocationFailureKind } from "./invocation-error.js";

const messages = new WeakMap<Error, string>();

const INVOCATION_MESSAGES: Record<ModelGatewayInvocationFailureKind, string> = {
  network: "Can't reach the model gateway. Check that ABot is running and that the model gateway address is correct.",
  http: "The model service could not complete the request. Check the model connection and configuration.",
  stream: "The model service stopped before the response was complete. Try again.",
  inactivity: "The model service took too long to respond. Check that it is running and try again.",
  missing_stream: "The model service returned no response stream. Try again.",
};

/** Presentation is separate from diagnostic messages and transport classification. */
export function readModelGatewayUserMessage(error: unknown): string | undefined {
  return error instanceof Error ? messages.get(error) : undefined;
}

/** An owning adapter may preserve verified presentation when wrapping a failure. */
export function inheritModelGatewayUserMessage(target: Error, source: unknown): void {
  const message = readModelGatewayUserMessage(source);
  if (message) messages.set(target, message);
}

export function attachModelGatewayInvocationUserMessage(
  error: Error,
  kind: ModelGatewayInvocationFailureKind,
): void {
  messages.set(error, INVOCATION_MESSAGES[kind]);
}

export function attachModelGatewayHttpUserMessage<T extends Error>(
  error: T,
  status: number,
  presentationHeader: string | null | undefined,
  contentAllowed: boolean,
): T {
  const knownMessage = contentAllowed ? readProviderUserErrorMessage(presentationHeader) : undefined;
  messages.set(error, knownMessage ??
    `The model service could not complete the request (HTTP ${status}). Check the model connection and configuration.`);
  return error;
}
