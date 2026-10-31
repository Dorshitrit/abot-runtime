import {
  PROVIDER_CONTEXT_OVERFLOW,
  type ProviderContextOverflow,
} from "../../protocol/provider-context-overflow.js";

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isContextLengthError(value: unknown): boolean {
  const error = readRecord(value);
  if (error?.code !== "context_length_exceeded") return false;
  if (error.type === undefined) return true;
  return error.type === "invalid_request_error";
}

/** Only a structured provider rejection qualifies, independently of its message. */
export function readOpenAIHttpContextOverflow(
  status: number,
  body: string,
  contextOverflowRecovery?: true,
): ProviderContextOverflow | undefined {
  if (!contextOverflowRecovery) return undefined;
  if (status !== 400) return undefined;
  let value: unknown;
  try { value = JSON.parse(body); } catch { return undefined; }
  if (!isContextLengthError(readRecord(value)?.error)) return undefined;
  return PROVIDER_CONTEXT_OVERFLOW;
}

export function readOpenAIStreamContextOverflow(
  value: unknown,
  contextOverflowRecovery?: true,
): ProviderContextOverflow | undefined {
  if (!contextOverflowRecovery) return undefined;
  const event = readRecord(value);
  if (event?.type === "response.failed") {
    const response = readRecord(event.response);
    if (response?.status !== "failed") return undefined;
    if (!isContextLengthError(response.error)) return undefined;
    return PROVIDER_CONTEXT_OVERFLOW;
  }
  if (event?.type !== "error") return undefined;
  // Responses error events expose code directly; older streams nest the error.
  const error = event.code === undefined ? event.error : { code: event.code };
  if (!isContextLengthError(error)) return undefined;
  return PROVIDER_CONTEXT_OVERFLOW;
}
