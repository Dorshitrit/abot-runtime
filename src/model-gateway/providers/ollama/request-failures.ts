import { fetchProviderWithTrace } from "../../model-io-trace.js";
import type { ProviderUserErrorPresentation } from "../../protocol/provider-user-error.js";
import type { ModelProviderInvocationError } from "../contracts.js";
import { isAbortFailure } from "./stream-diagnostics.js";

type TracedProviderResponse = Awaited<ReturnType<typeof fetchProviderWithTrace>>;
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH",
  "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT",
]);

export async function fetchOllamaProviderResponse(
  params: Parameters<typeof fetchProviderWithTrace>[0] & { abortSignal?: AbortSignal },
): Promise<TracedProviderResponse | ModelProviderInvocationError> {
  try {
    return await fetchProviderWithTrace(params);
  } catch (error) {
    if (params.abortSignal?.aborted || isAbortFailure(error)) throw error;
    if (!hasOllamaConnectionFailure(error)) throw error;
    // fetchProviderWithTrace has already settled its failure trace.
    console.error(error);
    return {
      kind: "error",
      statusCode: 500,
      message: "server error",
      presentation: { code: "ollama_unreachable", endpoint: params.url },
    };
  }
}

export function isOllamaProviderRequestFailure(
  result: TracedProviderResponse | ModelProviderInvocationError,
): result is ModelProviderInvocationError {
  return "kind" in result && result.kind === "error";
}

export function resolveOllamaHttpFailurePresentation(options: {
  status: number;
  body: string;
  model: string;
  endpoint: string;
}): ProviderUserErrorPresentation | undefined {
  if (options.status !== 404 || !isOllamaMissingModelResponse(options.body, options.model))
    return undefined;
  return {
    code: "ollama_model_not_found", endpoint: options.endpoint, model: options.model,
  };
}

function isOllamaMissingModelResponse(body: string, model: string): boolean {
  if (body.length > 4_096) return false;
  let value: unknown;
  try { value = JSON.parse(body); } catch { return false; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const error = (value as Record<string, unknown>).error;
  return error === `model '${model}' not found` ||
    error === `model '${model}' not found, try pulling it first`;
}

function hasOllamaConnectionFailure(error: unknown, depth = 0): boolean {
  if (depth > 4 || !(error instanceof Error)) return false;
  if ("code" in error && typeof error.code === "string" && CONNECTION_ERROR_CODES.has(error.code))
    return true;
  if (hasOllamaConnectionFailure(error.cause, depth + 1)) return true;
  if (!(error instanceof AggregateError)) return false;
  return error.errors.some((cause: unknown) => hasOllamaConnectionFailure(cause, depth + 1));
}
