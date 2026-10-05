const SPARK_NOTIFICATION_QUERY_KEYS = new Set([
  "environment",
  "spark",
  "message",
  "messageCreatedAt",
  "request",
]);

function hasSingleAllowedSparkParameters(parameters: URLSearchParams): boolean {
  for (const key of parameters.keys()) {
    if (!SPARK_NOTIFICATION_QUERY_KEYS.has(key)) return false;
    if (parameters.getAll(key).length !== 1) return false;
  }
  return true;
}

function isSparkNotificationReference(value: string | null): value is string {
  if (value === null) return false;
  if (value.trim() !== value) return false;
  if (!value.length) return false;
  if (value.length > 512) return false;
  return !/[\u0000-\u001f\u007f]/u.test(value);
}

function hasCanonicalSparkMessageTimestamp(value: string | null): boolean {
  if (value === null) return false;
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp)) return false;
  if (timestamp < 0) return false;
  return String(timestamp) === value;
}

function hasSparkMessageReference(parameters: URLSearchParams): boolean {
  return ["message", "messageCreatedAt", "request"].some((key) =>
    parameters.has(key),
  );
}

/** Validate the SPARK source link before the native host opens it. */
export function hasBoundSparkNotificationQuery(url: URL): boolean {
  if (url.pathname !== "/home") return false;
  const parameters = url.searchParams;
  if (!hasSingleAllowedSparkParameters(parameters)) return false;
  if (!isSparkNotificationReference(parameters.get("environment")))
    return false;
  if (parameters.get("spark") !== "1") return false;
  if (!hasSparkMessageReference(parameters)) return true;
  if (!isSparkNotificationReference(parameters.get("message"))) return false;
  if (!hasCanonicalSparkMessageTimestamp(parameters.get("messageCreatedAt")))
    return false;
  const request = parameters.get("request");
  if (request === null) return true;
  return isSparkNotificationReference(request);
}
