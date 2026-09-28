import {
  NotificationInputError,
  type NotificationPreferences,
  type NotificationReadChange,
} from "./contracts.js";
import {
  hasOnlyNotificationFields,
  isNotificationIdentifier,
  isNotificationPreferences,
  isNotificationRecord,
} from "./storage-schema.js";

export function parseNotificationEnvironment(value: unknown): string {
  if (!isNotificationIdentifier(value))
    throw new NotificationInputError(
      "An explicit notification environment is required.",
    );
  return value;
}

export function parseNotificationReadChange(
  value: unknown,
): NotificationReadChange {
  if (!isNotificationRecord(value))
    throw new NotificationInputError("Invalid notification read selection.");
  if (!hasOnlyNotificationFields(value, ["all", "ids", "read"]))
    throw new NotificationInputError("Invalid notification read selection.");
  if (typeof value.read !== "boolean")
    throw new NotificationInputError("A notification read state is required.");
  if (value.all === true) {
    if (value.ids !== undefined)
      throw new NotificationInputError(
        "Choose all notifications or explicit identities.",
      );
    if (value.read !== true)
      throw new NotificationInputError(
        "All notifications can only be marked read.",
      );
    return { all: true, read: true };
  }
  if (value.all !== undefined)
    throw new NotificationInputError("Invalid notification read selection.");
  if (!Array.isArray(value.ids))
    throw new NotificationInputError("Notification identities are required.");
  if (!value.ids.length)
    throw new NotificationInputError("Notification identities are required.");
  if (value.ids.length > 1000)
    throw new NotificationInputError("Too many notification identities.");
  if (!value.ids.every(isNotificationIdentifier))
    throw new NotificationInputError("Invalid notification identity.");
  return { ids: [...new Set(value.ids)], read: value.read };
}

export function parseNotificationReadBody(body: Record<string, unknown>): {
  environmentId: string;
  change: NotificationReadChange;
} {
  const { environment, ...change } = body;
  return {
    environmentId: parseNotificationEnvironment(environment),
    change: parseNotificationReadChange(change),
  };
}

export function parseNotificationPreferencesBody(
  body: Record<string, unknown>,
): {
  environmentId: string;
  preferences: NotificationPreferences;
} {
  const { environment, ...preferences } = body;
  const environmentId = parseNotificationEnvironment(environment);
  if (!isNotificationPreferences(preferences))
    throw new NotificationInputError(
      "Complete notification preferences are required.",
    );
  return { environmentId, preferences };
}
