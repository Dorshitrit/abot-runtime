import type {
  NotificationDesktopState,
  NotificationListQuery,
  NotificationPage,
  NotificationPreferences,
  NotificationReadChange,
  NotificationReadResult,
} from "../../../notifications/contracts.js";

export interface NotificationRequests {
  supportsNotifications(): boolean;
  listNotifications(
    environmentId?: string,
    page?: NotificationListQuery,
  ): Promise<{ ok: true; desktop: NotificationDesktopState } & NotificationPage>;
  markNotificationsRead(
    input: NotificationReadChange,
    environmentId?: string,
  ): Promise<{ ok: true } & NotificationReadResult>;
  saveNotificationPreferences(
    input: NotificationPreferences,
    environmentId?: string,
  ): Promise<{ ok: true; preferences: NotificationPreferences }>;
}

export function createNotificationRequests(options: {
  requestApi(path: string, options?: RequestInit): Promise<unknown>;
  getConfig(): Record<string, unknown> | null;
  getEnvironmentId(): string;
}): NotificationRequests;
