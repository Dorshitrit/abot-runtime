import type {
  NotificationDelivery,
  NotificationPreferences,
  WebNotification,
} from "./contracts.js";

export type NotificationStoreState = {
  version: 1;
  environmentId: string;
  items: WebNotification[];
  preferences: NotificationPreferences;
};

export function isNotificationRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null) return false;
  if (typeof value !== "object") return false;
  return !Array.isArray(value);
}

export function hasOnlyNotificationFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function isNotificationIdentifier(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.trim() !== value) return false;
  if (!value.length) return false;
  if (value.length > 512) return false;
  return !/[\u0000-\u001f\u007f]/u.test(value);
}

export function isNotificationTimestamp(value: unknown): value is number {
  if (typeof value !== "number") return false;
  if (!Number.isSafeInteger(value)) return false;
  return value >= 0;
}

function isNotificationText(value: unknown, maximum: number): value is string {
  if (typeof value !== "string") return false;
  return value.length <= maximum;
}

export function isNotificationPreferences(
  value: unknown,
): value is NotificationPreferences {
  if (!isNotificationRecord(value)) return false;
  if (!hasOnlyNotificationFields(value, ["desktopEnabled", "kinds"]))
    return false;
  if (typeof value.desktopEnabled !== "boolean") return false;
  if (!isNotificationRecord(value.kinds)) return false;
  const kinds = ["reply", "failure", "approval", "proposal"];
  const preferences = value.kinds;
  if (!hasOnlyNotificationFields(preferences, kinds)) return false;
  return kinds.every((kind) => typeof preferences[kind] === "boolean");
}

export function isNotificationDelivery(
  value: unknown,
): value is NotificationDelivery {
  if (!isNotificationRecord(value)) return false;
  if (!hasOnlyNotificationFields(value, ["status", "error"])) return false;
  const statuses = [
    "pending",
    "submitted",
    "disabled",
    "unavailable",
    "failed",
    "unknown",
  ];
  if (typeof value.status !== "string") return false;
  if (!statuses.includes(value.status)) return false;
  if (value.error === undefined) return true;
  return isNotificationText(value.error, 4096);
}

function hasBoundNotificationSource(value: Record<string, unknown>): boolean {
  if (typeof value.sourceUrl !== "string") return false;
  if (!value.sourceUrl.startsWith("/chat?")) return false;
  try {
    const url = new URL(value.sourceUrl, "http://notification.local");
    if (url.origin !== "http://notification.local") return false;
    if (url.pathname !== "/chat") return false;
    if (url.hash) return false;
    if (url.searchParams.get("environment") !== value.environmentId)
      return false;
    if (url.searchParams.get("session") !== value.sessionId) return false;
    if (url.searchParams.getAll("environment").length !== 1) return false;
    if (url.searchParams.getAll("session").length !== 1) return false;
    return [...url.searchParams.keys()].every((key) =>
      ["environment", "session"].includes(key),
    );
  } catch {
    return false;
  }
}

export function isWebNotification(
  value: unknown,
  environmentId: string,
): value is WebNotification {
  if (!isNotificationRecord(value)) return false;
  const fields = [
    "id",
    "kind",
    "title",
    "body",
    "createdAt",
    "readAt",
    "environmentId",
    "sessionId",
    "requestId",
    "sourceUrl",
    "delivery",
  ];
  if (!hasOnlyNotificationFields(value, fields)) return false;
  if (!isNotificationIdentifier(value.id)) return false;
  if (typeof value.kind !== "string") return false;
  if (!["reply", "failure", "approval", "proposal"].includes(value.kind))
    return false;
  if (!isNotificationText(value.title, 1024)) return false;
  if (!value.title.trim()) return false;
  if (!isNotificationText(value.body, 16384)) return false;
  if (!isNotificationTimestamp(value.createdAt)) return false;
  if (value.readAt !== null && !isNotificationTimestamp(value.readAt))
    return false;
  if (value.environmentId !== environmentId) return false;
  if (!isNotificationIdentifier(value.sessionId)) return false;
  if (
    value.requestId !== undefined &&
    !isNotificationIdentifier(value.requestId)
  )
    return false;
  if (!hasBoundNotificationSource(value)) return false;
  return isNotificationDelivery(value.delivery);
}

export function decodeNotificationState(
  raw: string,
  environmentId: string,
): NotificationStoreState {
  const value: unknown = JSON.parse(raw);
  if (!isNotificationRecord(value))
    throw new Error("Invalid notification storage.");
  if (value.version !== 1)
    throw new Error("Unsupported notification storage version.");
  if (value.environmentId !== environmentId)
    throw new Error("Notification storage environment mismatch.");
  if (
    !hasOnlyNotificationFields(value, [
      "version",
      "environmentId",
      "items",
      "preferences",
    ])
  )
    throw new Error("Unexpected notification storage fields.");
  if (!isNotificationPreferences(value.preferences))
    throw new Error("Invalid notification preferences.");
  if (!Array.isArray(value.items))
    throw new Error("Invalid notification history.");
  const seen = new Set<string>();
  for (const item of value.items) {
    if (!isWebNotification(item, environmentId))
      throw new Error("Invalid stored notification.");
    if (seen.has(item.id)) throw new Error("Duplicate stored notification.");
    seen.add(item.id);
  }
  return value as NotificationStoreState;
}
