import { SPARK_SESSION_ID } from "../../sessions/spark-session.js";
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
  const kinds = ["reply", "failure", "approval", "proposal", "automation"];
  const preferences = value.kinds;
  if (!hasOnlyNotificationFields(preferences, kinds)) return false;
  return kinds.every((kind) => typeof preferences[kind] === "boolean");
}

function normalizeStoredNotificationPreferences(
  value: unknown,
): NotificationPreferences | null {
  if (isNotificationPreferences(value)) return value;
  if (!isNotificationRecord(value)) return null;
  if (!hasOnlyNotificationFields(value, ["desktopEnabled", "kinds"]))
    return null;
  if (typeof value.desktopEnabled !== "boolean") return null;
  if (!isNotificationRecord(value.kinds)) return null;
  const kinds = value.kinds;
  const legacyKinds = ["reply", "failure", "approval", "proposal"];
  if (!hasOnlyNotificationFields(kinds, legacyKinds)) return null;
  if (!legacyKinds.every((kind) => typeof kinds[kind] === "boolean"))
    return null;
  return {
    desktopEnabled: value.desktopEnabled,
    kinds: {
      reply: kinds.reply as boolean,
      failure: kinds.failure as boolean,
      approval: kinds.approval as boolean,
      proposal: kinds.proposal as boolean,
      automation: true,
    },
  };
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

type NotificationSourceTarget = {
  path: string;
  parameters: Record<string, string>;
};

function sparkNotificationSourceTarget(
  value: Record<string, unknown>,
  source: URLSearchParams,
): NotificationSourceTarget | null {
  if (value.sessionKind !== "spark") return null;
  if (value.sessionId !== SPARK_SESSION_ID) return null;
  const parameters: Record<string, string> = {
    environment: value.environmentId as string,
    spark: "1",
  };
  const message = source.get("message");
  const createdAt = source.get("messageCreatedAt");
  const request = source.get("request");
  if (message === null && createdAt === null && request === null)
    return { path: "/home", parameters };
  if (!isNotificationIdentifier(message)) return null;
  if (createdAt === null || !isNotificationTimestamp(Number(createdAt))) return null;
  if (String(Number(createdAt)) !== createdAt) return null;
  parameters.message = message;
  parameters.messageCreatedAt = createdAt;
  if (request !== (value.requestId ?? null)) return null;
  if (request !== null) parameters.request = request;
  return { path: "/home", parameters };
}

function notificationSourceTarget(
  value: Record<string, unknown>,
  source: URLSearchParams,
): NotificationSourceTarget | null {
  if (value.kind === "automation") {
    if (!isNotificationIdentifier(value.automationId)) return null;
    if (!isNotificationIdentifier(value.runId)) return null;
    if (value.sessionId !== undefined) return null;
    if (value.sessionKind !== undefined) return null;
    if (value.requestId !== undefined) return null;
    return {
      path: "/automations",
      parameters: {
        environment: value.environmentId as string,
        automation: value.automationId,
        run: value.runId,
      },
    };
  }
  if (!isNotificationIdentifier(value.sessionId)) return null;
  if (value.automationId !== undefined) return null;
  if (value.runId !== undefined) return null;
  if (value.requestId !== undefined && !isNotificationIdentifier(value.requestId))
    return null;
  if (value.sessionKind !== undefined) return sparkNotificationSourceTarget(value, source);
  return {
    path: "/chat",
    parameters: {
      environment: value.environmentId as string,
      session: value.sessionId,
    },
  };
}

function hasBoundNotificationSource(value: Record<string, unknown>): boolean {
  if (typeof value.sourceUrl !== "string") return false;
  try {
    const url = new URL(value.sourceUrl, "http://notification.local");
    const target = notificationSourceTarget(value, url.searchParams);
    if (!target) return false;
    if (!value.sourceUrl.startsWith(`${target.path}?`)) return false;
    if (url.origin !== "http://notification.local") return false;
    if (url.pathname !== target.path) return false;
    if (url.hash) return false;
    const expectedKeys = Object.keys(target.parameters);
    for (const key of expectedKeys) {
      if (url.searchParams.getAll(key).length !== 1) return false;
      if (url.searchParams.get(key) !== target.parameters[key]) return false;
    }
    return [...url.searchParams.keys()].every((key) =>
      expectedKeys.includes(key),
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
    "sessionKind",
    "requestId",
    "automationId",
    "runId",
    "sourceUrl",
    "delivery",
  ];
  if (!hasOnlyNotificationFields(value, fields)) return false;
  if (!isNotificationIdentifier(value.id)) return false;
  if (typeof value.kind !== "string") return false;
  if (!["reply", "failure", "approval", "proposal", "automation"].includes(value.kind))
    return false;
  if (!isNotificationText(value.title, 1024)) return false;
  if (!value.title.trim()) return false;
  if (!isNotificationText(value.body, 16384)) return false;
  if (!isNotificationTimestamp(value.createdAt)) return false;
  if (value.readAt !== null && !isNotificationTimestamp(value.readAt))
    return false;
  if (value.environmentId !== environmentId) return false;
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
  const preferences = normalizeStoredNotificationPreferences(value.preferences);
  if (!preferences)
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
  return { ...value, preferences } as NotificationStoreState;
}
