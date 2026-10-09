function hasPositiveContextTokenCount(value) {
  if (!Number.isSafeInteger(value)) return false;
  return value > 0;
}

function hasSupportedContextConstraint(details) {
  if (details?.field !== "contextWindowTokens") return false;
  for (const field of ["declaredTokens", "effectiveTokens", "minimumTokens"]) {
    if (!hasPositiveContextTokenCount(details[field])) return false;
  }
  if (!Number.isSafeInteger(details.reservedTokens)) return false;
  if (details.reservedTokens < 0) return false;
  if (details.effectiveTokens > details.reservedTokens) return false;
  if (details.effectiveTokens > details.declaredTokens) return false;
  if (details.minimumTokens <= details.reservedTokens) return false;
  if (details.allocationTokens === undefined) return true;
  if (!hasPositiveContextTokenCount(details.allocationTokens)) return false;
  return details.effectiveTokens <= details.allocationTokens;
}

function hasInsufficientContextAllocation(details) {
  if (details.allocationTokens === undefined) return false;
  return details.allocationTokens < details.minimumTokens;
}

function formatContextConstraintMessage(details) {
  const tokens = (value) => value.toLocaleString("en-US");
  const capacity = `The effective context window is ${tokens(details.effectiveTokens)} tokens, but the current configuration reserves ${tokens(details.reservedTokens)} tokens.`;
  const minimum = `Use a context window of at least ${tokens(details.minimumTokens)} tokens supported by your model, or adjust the configured reserves.`;
  if (!hasInsufficientContextAllocation(details))
    return `${capacity} ${minimum}`;
  return `${capacity} ${minimum} The configured Ollama allocation (num_ctx) is ${tokens(details.allocationTokens)} tokens. It must also reach that minimum; increasing this field alone is insufficient.`;
}

/** Only numeric details from this known contract become user-visible feedback. */
export function readSetupContextWindowFeedback(error) {
  if (error?.status !== 400) return null;
  const payload = error.payload;
  if (payload?.ok !== false) return null;
  if (payload.error !== "context_window_too_small") return null;
  if (!hasSupportedContextConstraint(payload.contextWindow)) return null;
  return {
    minimumTokens: payload.contextWindow.minimumTokens,
    message: formatContextConstraintMessage(payload.contextWindow),
  };
}

/** A server constraint belongs to the rejected candidate, never later edits. */
export function clearSetupContextWindowFeedback(state, container) {
  if (!state.contextWindowFeedback) return;
  state.contextWindowFeedback = null;
  const field = container.querySelector(
    '[data-runtime-setup-field="context-window"]',
  );
  field?.removeAttribute?.("aria-invalid");
  field?.setAttribute?.("aria-describedby", "runtimeSetupHelp-context-window");
  field?.setAttribute?.("min", "1");
  container.querySelector("#runtimeSetupError-context-window")?.remove?.();
}

export function focusSetupContextWindowFeedback(
  container,
  feedback,
  restoreFocus,
) {
  if (!feedback) return;
  if (!restoreFocus) return;
  container
    .querySelector('[data-runtime-setup-field="context-window"]')
    ?.focus?.();
}
