import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  defaultNotificationPreferences,
  NotificationInputError,
  type NotificationDelivery,
  type NotificationListQuery,
  type NotificationPage,
  type NotificationPreferences,
  type NotificationReadChange,
  type NotificationReadResult,
  type WebNotification,
} from "./contracts.js";
import { parseNotificationReadChange } from "./request-input.js";
import {
  compareNotificationsNewestFirst,
  decodeNotificationCursor,
  encodeNotificationCursor,
  isNotificationBeforeCursor,
  notificationPageLimit,
} from "./query.js";
import {
  decodeNotificationState,
  isNotificationDelivery,
  isNotificationIdentifier,
  isNotificationPreferences,
  isNotificationTimestamp,
  isWebNotification,
  type NotificationStoreState,
} from "./storage-schema.js";

const pendingTransactions = new Map<string, Promise<unknown>>();

export function notificationStorePath(input: {
  runtimeDir: string;
  sessionsDir: string;
  environmentId: string;
}): string {
  const identity = JSON.stringify([
    input.environmentId,
    resolve(input.sessionsDir),
  ]);
  const filename =
    createHash("sha256").update(identity).digest("hex") + ".json";
  return join(input.runtimeDir, "web-ui", "notifications", filename);
}

function isMissingNotificationFile(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (!("code" in error)) return false;
  return error.code === "ENOENT";
}

function countUnreadNotifications(state: NotificationStoreState): number {
  return state.items.filter((item) => item.readAt === null).length;
}

function hasPendingNotificationDelivery(item: WebNotification): boolean {
  return item.delivery.status === "pending";
}

function needsNotificationReadChange(
  item: WebNotification,
  change: NotificationReadChange,
): boolean {
  if ("ids" in change && !change.ids.includes(item.id)) return false;
  return (item.readAt !== null) !== change.read;
}

/** Web UI history only: no writes to Runtime sessions or model-visible context. */
export class WebNotificationStore {
  private readonly path: string;

  constructor(
    path: string,
    private readonly environmentId: string,
  ) {
    if (!isNotificationIdentifier(environmentId))
      throw new NotificationInputError("Invalid notification environment.");
    this.path = resolve(path);
  }

  private async load(): Promise<NotificationStoreState | null> {
    try {
      return decodeNotificationState(
        await readFile(this.path, "utf8"),
        this.environmentId,
      );
    } catch (error) {
      if (isMissingNotificationFile(error)) return null;
      throw error;
    }
  }

  private async save(state: NotificationStoreState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async transaction<T>(
    operation: (state: NotificationStoreState) => T,
  ): Promise<T> {
    const prior = pendingTransactions.get(this.path) ?? Promise.resolve();
    const pending = prior
      .catch(() => undefined)
      .then(async () => {
        const existing = await this.load();
        const state: NotificationStoreState = existing ?? {
          version: 1,
          environmentId: this.environmentId,
          items: [],
          preferences: defaultNotificationPreferences(),
        };
        const before = JSON.stringify(state);
        const result = operation(state);
        if (!existing || before !== JSON.stringify(state))
          await this.save(state);
        return structuredClone(result);
      });
    pendingTransactions.set(this.path, pending);
    try {
      return await pending;
    } finally {
      if (pendingTransactions.get(this.path) === pending)
        pendingTransactions.delete(this.path);
    }
  }

  initialize(): Promise<void> {
    return this.transaction(() => undefined);
  }

  reconcilePendingDeliveries(): Promise<void> {
    return this.transaction((state) => {
      for (const item of state.items) {
        if (!hasPendingNotificationDelivery(item)) continue;
        item.delivery = {
          status: "unknown",
          error:
            "ABot restarted before delivery was confirmed. This notification was not sent again.",
        };
      }
    });
  }

  upsert(
    item: WebNotification,
  ): Promise<{ item: WebNotification; created: boolean }> {
    if (!isWebNotification(item, this.environmentId))
      throw new NotificationInputError("Invalid notification.");
    const inserted = structuredClone(item);
    return this.transaction((state) => {
      const existing = state.items.find(
        (candidate) => candidate.id === inserted.id,
      );
      if (existing) return { item: existing, created: false };
      state.items.push(inserted);
      return { item: inserted, created: true };
    });
  }

  list(query: NotificationListQuery = {}): Promise<NotificationPage> {
    const limit = notificationPageLimit(query);
    const cursor = decodeNotificationCursor(query.before, this.environmentId);
    return this.transaction((state) => {
      const ordered = state.items
        .filter((item) => isNotificationBeforeCursor(item, cursor))
        .sort(compareNotificationsNewestFirst);
      const items = ordered.slice(0, limit);
      const hasOlderItems = ordered.length > limit;
      return {
        items,
        unreadCount: countUnreadNotifications(state),
        nextCursor: hasOlderItems
          ? encodeNotificationCursor(items[items.length - 1])
          : null,
        preferences: state.preferences,
      };
    });
  }

  updateDelivery(id: string, delivery: NotificationDelivery): Promise<boolean> {
    if (!isNotificationIdentifier(id))
      throw new NotificationInputError("Invalid notification identity.");
    if (!isNotificationDelivery(delivery))
      throw new NotificationInputError("Invalid notification delivery.");
    const receipt = structuredClone(delivery);
    return this.transaction((state) => {
      const item = state.items.find((candidate) => candidate.id === id);
      if (!item) return false;
      item.delivery = receipt;
      return true;
    });
  }

  markRead(
    change: NotificationReadChange,
    now = Date.now(),
  ): Promise<NotificationReadResult> {
    const selection = parseNotificationReadChange(change);
    if (!isNotificationTimestamp(now))
      throw new NotificationInputError("Invalid notification read time.");
    return this.transaction((state) => {
      let updated = 0;
      for (const item of state.items) {
        if (!needsNotificationReadChange(item, selection)) continue;
        item.readAt = selection.read ? now : null;
        updated += 1;
      }
      return { updated, unreadCount: countUnreadNotifications(state) };
    });
  }

  getPreferences(): Promise<NotificationPreferences> {
    return this.transaction((state) => state.preferences);
  }

  setPreferences(
    preferences: NotificationPreferences,
  ): Promise<NotificationPreferences> {
    if (!isNotificationPreferences(preferences))
      throw new NotificationInputError("Invalid notification preferences.");
    const saved = structuredClone(preferences);
    return this.transaction((state) => {
      state.preferences = saved;
      return saved;
    });
  }
}
