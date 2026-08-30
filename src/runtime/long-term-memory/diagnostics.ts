import { traceDebug } from "../observability/debug-logger.js";

const SAFE_MEMORY_FAILURE_CODES = new Set([
  "long_term_memory_embedding_binding_changed",
  "long_term_memory_embedding_client_required",
  "long_term_memory_embedding_gateway_unavailable",
  "long_term_memory_embedding_profile_id_invalid",
  "long_term_memory_embedding_profile_required",
  "long_term_memory_embedding_vector_count_invalid",
  "long_term_memory_model_policy_required",
  "long_term_memory_store_corrupt",
  "long_term_memory_store_lock_timeout",
  "long_term_memory_store_schema_unsupported",
  "long_term_memory_vector_corrupt",
  "memory_store_unavailable",
  "model_gateway_embedding_binding_invalid",
  "model_gateway_embedding_dimensions_inconsistent",
  "model_gateway_embedding_dimensions_invalid",
  "model_gateway_embedding_profile_mismatch",
  "model_gateway_embedding_request_invalid",
  "model_gateway_embedding_response_invalid",
  "model_gateway_embedding_vector_count_invalid",
  "model_gateway_embedding_vector_empty",
  "model_gateway_embedding_vector_invalid",
  "model_gateway_embedding_vector_non_finite",
]);

const GENERIC_MEMORY_FAILURE_CODE = "long_term_memory_unavailable";

export function traceLongTermMemoryOperation(params: {
  operation: "retrieval" | "save";
  outcome: "completed" | "failed" | "skipped";
  requestId: string;
  durationMs: number;
  counts?: Record<string, number>;
  reason?: string;
}): void {
  traceDebug("runtime.long_term_memory", `${params.operation}.${params.outcome}`, {
    requestId: params.requestId,
    operation: params.operation,
    outcome: params.outcome,
    durationMs: params.durationMs,
    ...(params.counts ?? {}),
    ...(params.reason ? { reason: params.reason } : {}),
  });
}

export function classifyMemoryFailure(error: unknown): string {
  const errorCode = error instanceof Error ? error.message : "";
  return SAFE_MEMORY_FAILURE_CODES.has(errorCode)
    ? errorCode
    : GENERIC_MEMORY_FAILURE_CODE;
}
