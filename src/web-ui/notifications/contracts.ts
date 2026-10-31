import type { SessionKind } from "../../sessions/spark-session.js";

export type NotificationKind =
  | "reply"
  | "failure"
  | "approval"
  | "proposal"
  | "automation";

export type NotificationDelivery = {
  status:
    | "pending"
    | "submitted"
    | "disabled"
    | "unavailable"
    | "failed"
    | "unknown";
  error?: string;
};

type NotificationDetails = {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  readAt: number | null;
  environmentId: string;
  sourceUrl: string;
  delivery: NotificationDelivery;
};

export type WebNotification = NotificationDetails &
  (
    | {
        kind: "automation";
        automationId: string;
        runId: string;
        sessionId?: never;
        sessionKind?: never;
        requestId?: never;
      }
    | {
        kind: Exclude<NotificationKind, "automation">;
        sessionId: string;
        /** Copied only from the canonical persisted session. */
        sessionKind?: SessionKind;
        requestId?: string;
        automationId?: never;
        runId?: never;
      }
  );

export type NotificationPreferences = {
  desktopEnabled: boolean;
  kinds: Record<NotificationKind, boolean>;
};

export type NotificationListQuery = { limit?: number; before?: string };
export type NotificationPage = {
  items: WebNotification[];
  unreadCount: number;
  nextCursor: string | null;
  preferences: NotificationPreferences;
};
export type NotificationReadChange =
  | { ids: string[]; read: boolean }
  | { all: true; read: true };
export type AutomationReportRead = { runId: string; phase: "started" | "finished" };
export type NotificationReadResult = { updated: number; unreadCount: number };
export type NotificationDesktopState = {
  available: boolean;
  message?: string;
  computerName?: string;
};

export class NotificationInputError extends Error {}

export function defaultNotificationPreferences(): NotificationPreferences {
  return {
    desktopEnabled: true,
    kinds: {
      reply: true,
      failure: true,
      approval: true,
      proposal: true,
      automation: true,
    },
  };
}
