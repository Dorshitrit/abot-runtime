import {
  NotificationInputError,
  type NotificationListQuery,
  type WebNotification,
} from "./contracts.js";
import {
  hasOnlyNotificationFields,
  isNotificationIdentifier,
  isNotificationRecord,
  isNotificationTimestamp,
} from "./storage-schema.js";

type NotificationCursor = {
  version: 1;
  environmentId: string;
  createdAt: number;
  id: string;
};

function isNotificationPageLimit(value: unknown): value is number {
  if (typeof value !== "number") return false;
  if (!Number.isSafeInteger(value)) return false;
  if (value < 1) return false;
  return value <= 100;
}

export function parseNotificationListQuery(
  params: URLSearchParams,
): NotificationListQuery {
  for (const key of params.keys()) {
    if (!["environment", "limit", "before"].includes(key))
      throw new NotificationInputError("Unknown notification query parameter.");
    if (params.getAll(key).length !== 1)
      throw new NotificationInputError(
        "Repeated notification query parameter.",
      );
  }
  const rawLimit = params.get("limit");
  if (rawLimit === null) return { before: params.get("before") ?? undefined };
  if (!/^[1-9]\d{0,2}$/u.test(rawLimit))
    throw new NotificationInputError(
      "Notification page limit must be 1 to 100.",
    );
  const limit = Number(rawLimit);
  if (!isNotificationPageLimit(limit))
    throw new NotificationInputError(
      "Notification page limit must be 1 to 100.",
    );
  return { limit, before: params.get("before") ?? undefined };
}

export function notificationPageLimit(query: NotificationListQuery): number {
  const limit = query.limit ?? 50;
  if (!isNotificationPageLimit(limit))
    throw new NotificationInputError(
      "Notification page limit must be 1 to 100.",
    );
  return limit;
}

export function decodeNotificationCursor(
  raw: string | undefined,
  environmentId: string,
): NotificationCursor | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string")
    throw new NotificationInputError("Invalid notification cursor.");
  if (raw.length > 2048)
    throw new NotificationInputError("Invalid notification cursor.");
  if (!/^[A-Za-z0-9_-]+$/u.test(raw))
    throw new NotificationInputError("Invalid notification cursor.");
  let cursor: unknown;
  try {
    cursor = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new NotificationInputError("Invalid notification cursor.");
  }
  if (!isNotificationRecord(cursor))
    throw new NotificationInputError("Invalid notification cursor.");
  if (
    !hasOnlyNotificationFields(cursor, [
      "version",
      "environmentId",
      "createdAt",
      "id",
    ])
  )
    throw new NotificationInputError("Invalid notification cursor.");
  if (cursor.version !== 1)
    throw new NotificationInputError("Invalid notification cursor.");
  if (cursor.environmentId !== environmentId)
    throw new NotificationInputError(
      "Notification cursor belongs to another environment.",
    );
  if (!isNotificationTimestamp(cursor.createdAt))
    throw new NotificationInputError("Invalid notification cursor.");
  if (!isNotificationIdentifier(cursor.id))
    throw new NotificationInputError("Invalid notification cursor.");
  return cursor as NotificationCursor;
}

export function encodeNotificationCursor(item: WebNotification): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      environmentId: item.environmentId,
      createdAt: item.createdAt,
      id: item.id,
    }),
  ).toString("base64url");
}

export function compareNotificationsNewestFirst(
  left: WebNotification,
  right: WebNotification,
): number {
  if (left.createdAt !== right.createdAt)
    return right.createdAt - left.createdAt;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

export function isNotificationBeforeCursor(
  item: WebNotification,
  cursor: NotificationCursor | null,
): boolean {
  if (cursor === null) return true;
  if (item.createdAt !== cursor.createdAt)
    return item.createdAt < cursor.createdAt;
  return item.id < cursor.id;
}
