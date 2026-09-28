export type NotificationKind = "reply" | "failure" | "approval" | "proposal";

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

export type WebNotification = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  createdAt: number;
  readAt: number | null;
  environmentId: string;
  sessionId: string;
  requestId?: string;
  sourceUrl: string;
  delivery: NotificationDelivery;
};

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
    kinds: { reply: true, failure: true, approval: true, proposal: true },
  };
}
