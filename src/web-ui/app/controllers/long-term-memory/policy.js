export function lastPageOffset(total, pageSize) {
  return Math.max(
    0,
    Math.floor((Math.max(1, total) - 1) / pageSize) * pageSize,
  );
}

export function previousPageOffsetAfterDelete(state) {
  const remaining = Math.max(0, state.total - 1);
  return state.offset >= remaining && state.offset > 0
    ? Math.max(0, state.offset - state.limit)
    : state.offset;
}

export function canUseMemoryEmbeddings(state) {
  return state.enabled === true && state.available === true;
}

export function unavailableMemoryActionMessage(action) {
  return `Enable an available embedding model to ${action} memories.`;
}

export function isMemoryConflictError(error) {
  return (
    error?.code === "long_term_memory_management_conflict" ||
    error?.status === 409
  );
}

export function isMemoryMissingError(error) {
  return (
    error?.code === "long_term_memory_management_not_found" ||
    error?.status === 404
  );
}

export function isAbortError(error) {
  return error?.name === "AbortError";
}

export function managementErrorMessage(error) {
  const messages = {
    long_term_memory_disabled:
      "Long-term memory is disabled. Existing memories remain available to view or delete.",
    long_term_memory_unavailable:
      "The embedding provider is unavailable. Existing memories remain available to view or delete.",
    long_term_memory_management_conflict:
      "This memory changed elsewhere. The latest stored version has been reloaded.",
    long_term_memory_management_duplicate:
      "An identical memory already exists.",
    long_term_memory_management_input_invalid:
      "Enter valid memory content and tags.",
    long_term_memory_management_not_found: "This memory no longer exists.",
    long_term_memory_management_sensitive_data:
      "This memory may contain a password, key, token, or other sensitive data and was not saved.",
  };
  return (
    messages[error?.code] ||
    (error instanceof Error ? error.message : String(error))
  );
}
