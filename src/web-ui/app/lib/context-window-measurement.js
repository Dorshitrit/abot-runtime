/** Numeric evidence is never coerced: null and missing counts are unknown. */
export function isContextTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isContextCapacity(value) {
  return isContextTokenCount(value) && value > 0;
}

export function contextUsedPercent(inputTokens, capacity) {
  return Math.round((inputTokens / capacity) * 1000) / 10;
}

export function selectContextInputMeasurement(message) {
  if (!isContextCapacity(message.contextWindowTokens)) return null;
  const actual = isContextTokenCount(message.measuredInputTokens);
  if (!actual && !isContextTokenCount(message.estimatedInputTokens))
    return null;
  const inputTokens = actual
    ? message.measuredInputTokens
    : message.estimatedInputTokens;
  const measurementKind = actual ? "actual" : "estimated";
  const source = actual
    ? "provider_input_token_count"
    : "runtime_token_estimator";
  const usedContextPercent = contextUsedPercent(
    inputTokens,
    message.contextWindowTokens,
  );
  return {
    inputTokens,
    measurementKind,
    measurement: measurementKind,
    source,
    contextWindowTokens: message.contextWindowTokens,
    usedContextPercent,
    remainingContextTokens: Math.max(
      0,
      message.contextWindowTokens - inputTokens,
    ),
    remainingContextPercent: Math.max(
      0,
      Math.round((100 - usedContextPercent) * 10) / 10,
    ),
    ...(isContextTokenCount(message.estimatedInputTokens)
      ? { estimatedInputTokens: message.estimatedInputTokens }
      : {}),
    ...(actual ? { measuredInputTokens: message.measuredInputTokens } : {}),
    metadataMismatch: hasContextMeasurementMismatch(
      message,
      measurementKind,
      source,
    ),
  };
}

function hasContextMeasurementMismatch(message, measurement, source) {
  if (message.measurement && message.measurement !== measurement) return true;
  if (message.source && message.source !== source) return true;
  return false;
}

export function normalizeContextProviderCounts(message) {
  const counts = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens"]) {
    if (isContextTokenCount(message[key])) counts[key] = message[key];
  }
  return Object.keys(counts).length ? counts : null;
}

function isContextPercentage(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function selectCompactionPercentages(message) {
  const keys = ["beforeInputTokens", "afterInputTokens", "contextWindowTokens"];
  const hasTokenTuple = keys.some((key) => Object.hasOwn(message, key));
  if (!hasTokenTuple) {
    if (!isContextPercentage(message.beforeUsedContextPercent)) return null;
    if (!isContextPercentage(message.afterUsedContextPercent)) return null;
    return {
      beforePercent: message.beforeUsedContextPercent,
      afterPercent: message.afterUsedContextPercent,
    };
  }
  if (!isContextTokenCount(message.beforeInputTokens)) return null;
  if (!isContextTokenCount(message.afterInputTokens)) return null;
  if (!isContextCapacity(message.contextWindowTokens)) return null;
  return {
    beforePercent: contextUsedPercent(
      message.beforeInputTokens,
      message.contextWindowTokens,
    ),
    afterPercent: contextUsedPercent(
      message.afterInputTokens,
      message.contextWindowTokens,
    ),
  };
}
