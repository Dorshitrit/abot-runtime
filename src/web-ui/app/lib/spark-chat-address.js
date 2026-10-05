export function canRestoreSparkAddress(address, environmentId) {
  if (address.searchParams.get("spark") !== "1") return false;
  const requestedEnvironment = address.searchParams.get("environment");
  if (!requestedEnvironment) return false;
  return requestedEnvironment === environmentId;
}

export function sparkNotificationReference(address) {
  const timestamp = address.searchParams.get("messageCreatedAt");
  if (timestamp === null || !Number.isFinite(Number(timestamp))) return null;
  return { createdAt: Number(timestamp), requestId: address.searchParams.get("request") || null };
}

export function resolveSparkMessageTarget(messages, id, reference) {
  if (id === undefined || id === null) return undefined;
  const message = (messages || []).find((entry) => String(entry.id) === String(id));
  if (!message) return undefined;
  if (reference === undefined) return String(message.id);
  if (!reference || message.createdAt !== reference.createdAt) return undefined;
  if ((message.requestId || null) !== reference.requestId) return undefined;
  return String(message.id);
}
