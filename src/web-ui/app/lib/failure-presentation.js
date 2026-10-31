import { textOf } from "./text-format.js";

const MODEL_TRANSPORT_FAILURE = "ABot could not get a response from the configured model. Check the model connection and configuration, then try again.";
const TRANSPORT_CODES = new Set([
  "model_provider_failure", "model_provider_http", "model_provider_network",
  "model_provider_missing_stream", "model_provider_stream", "model_provider_abort",
  "fetch failed", "no stream", "server error",
]);

/** Recognize legacy transport wrappers without interpreting their provider body. */
export function isTransportFailureText(value) {
  const error = textOf(value).trim();
  if (TRANSPORT_CODES.has(error)) return true;
  return /^(?:bridge_request_failed|bridge_raw_failed|model_stream_error)(?::|$)/u.test(error);
}

export function presentFailureText(value) {
  const error = textOf(value);
  if (isTransportFailureText(error)) return MODEL_TRANSPORT_FAILURE;
  return error.trim() ? error : "ABot could not complete the request.";
}

/** The existing persisted failure response is authoritative presentation. */
export function failureResponseText(terminal) {
  const persisted = terminal?.details?.stoppedResponse;
  if (typeof persisted === "string" && persisted.trim()) return presentFailureText(persisted);
  return presentFailureText(terminal?.error);
}
