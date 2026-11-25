import {
  NotificationInputError,
  type AutomationReportRead,
  type NotificationPreferences,
  type NotificationReadChange,
} from "./contracts.js";
import {
  hasOnlyNotificationFields,
  isNotificationIdentifier,
  isNotificationPreferences,
  isNotificationRecord,
} from "./storage-schema.js";
import { isIssueCounter } from "./issue-schema.js";

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
  if (!hasOnlyNotificationFields(value, ["all", "ids", "read", "observedIssues", "issueReadBoundary"]))
    throw new NotificationInputError("Invalid notification read selection.");
  if (typeof value.read !== "boolean")
    throw new NotificationInputError("A notification read state is required.");
  if (value.all === true) {
    if (value.ids !== undefined || value.observedIssues !== undefined)
      throw new NotificationInputError(
        "Choose all notifications or explicit identities.",
      );
    if (value.read !== true)
      throw new NotificationInputError(
        "All notifications can only be marked read.",
      );
    if (value.issueReadBoundary !== undefined && !isIssueCounter(value.issueReadBoundary))
      throw new NotificationInputError("Invalid notification issue read boundary.");
    return { all: true, read: true, ...(value.issueReadBoundary === undefined ? {} : { issueReadBoundary: value.issueReadBoundary as number }) };
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
  const ids = value.ids as string[];
  if (value.issueReadBoundary !== undefined)
    throw new NotificationInputError("Issue read boundaries require an all-notifications selection.");
  const observedIssues = value.observedIssues;
  if (observedIssues !== undefined) {
    if (!value.read || !Array.isArray(observedIssues) || observedIssues.length > 1000 ||
      !observedIssues.every((item) => isNotificationRecord(item) && hasOnlyNotificationFields(item, ["id", "occurrenceCount"]) &&
        isNotificationIdentifier(item.id) && ids.includes(item.id) && isIssueCounter(item.occurrenceCount) && item.occurrenceCount > 0) ||
      new Set(observedIssues.map((item) => item.id)).size !== observedIssues.length)
      throw new NotificationInputError("Invalid observed notification issue counts.");
  }
  return { ids: [...new Set(ids)], read: value.read,
    ...(observedIssues === undefined ? {} : { observedIssues: observedIssues as { id: string; occurrenceCount: number }[] }) };
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

export function parseAutomationReportReadBody(body: Record<string, unknown>): {
  environmentId: string; report: AutomationReportRead;
} {
  const environmentId = parseNotificationEnvironment(body.environment);
  if (!hasOnlyNotificationFields(body, ["environment", "runId", "phase"]) ||
    !isNotificationIdentifier(body.runId) ||
    (body.phase !== "started" && body.phase !== "finished"))
    throw new NotificationInputError("An exact automation run and observed phase are required.");
  return { environmentId, report: { runId: body.runId, phase: body.phase } };
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
