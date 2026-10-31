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
import { applyNotificationRetention } from "./retention.js";
import { applyExplicitNotificationReadOverride, initializeNotificationReadSynchronization } from "./storage-metadata.js";
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

export type NotificationStoreOptions = { now?: () => number; onPruned?: () => void };

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

function isAutomaticUnreadReply(item: WebNotification, overrides: Set<string>, sessionId?: string): boolean {
  if (item.kind !== "reply") return false;
  if (item.readAt !== null) return false;
  if (overrides.has(item.id)) return false;
  if (sessionId !== undefined && item.sessionId !== sessionId) return false;
  return true;
}

/** Web UI history only: no writes to Runtime sessions or model-visible context. */
export class WebNotificationStore {
  private readonly path: string;
  private readonly now: () => number;

  constructor(
    path: string,
    private readonly environmentId: string,
    private readonly options: NotificationStoreOptions = {},
  ) {
    if (!isNotificationIdentifier(environmentId))
      throw new NotificationInputError("Invalid notification environment.");
    this.path = resolve(path);
    this.now = options.now ?? Date.now;
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
    operation: (state: NotificationStoreState, now: number) => T,
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
          readSyncInitialized: true,
        };
        const before = JSON.stringify(state);
        const previousIds = new Set(state.items.map((item) => item.id));
        const now = this.now();
        if (!isNotificationTimestamp(now)) throw new NotificationInputError("Invalid notification time.");
        applyNotificationRetention(state, now);
        initializeNotificationReadSynchronization(state);
        const result = operation(state, now);
        if (!existing || before !== JSON.stringify(state)) await this.save(state);
        const retainedIds = new Set(state.items.map((item) => item.id));
        if ([...previousIds].some((id) => !retainedIds.has(id))) this.options.onPruned?.();
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
    return this.transaction((state, now) => {
      const existing = state.items.find((candidate) => candidate.id === inserted.id);
      if (existing) return { item: existing, created: false };
      if (state.tombstones?.some((receipt) => receipt.id === inserted.id))
        return { item: inserted, created: false };
      const sourceRead = state.sourceReads?.find((receipt) => receipt.id === inserted.id);
      if (sourceRead) inserted.readAt = sourceRead.readAt;
      state.items.push(inserted);
      applyNotificationRetention(state, now);
      return { item: inserted, created: state.items.some((candidate) => candidate.id === inserted.id) };
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
    now = this.now(),
  ): Promise<NotificationReadResult> {
    const selection = parseNotificationReadChange(change);
    if (!isNotificationTimestamp(now))
      throw new NotificationInputError("Invalid notification read time.");
    return this.transaction((state) => {
      applyExplicitNotificationReadOverride(state, selection);
      let updated = 0;
      for (const item of state.items) {
        if (!needsNotificationReadChange(item, selection)) continue;
        item.readAt = selection.read ? now : null;
        updated += 1;
      }
      return { updated, unreadCount: countUnreadNotifications(state) };
    });
  }

  /** Explicit source actions also cover notifications queued after the action. */
  markSourceRead(ids: string[], now = this.now()): Promise<NotificationReadResult> {
    const selection = parseNotificationReadChange({ ids, read: true });
    if (!isNotificationTimestamp(now)) throw new NotificationInputError("Invalid notification read time.");
    const selected = new Set(ids);
    return this.transaction((state, transactionTime) => {
      applyExplicitNotificationReadOverride(state, selection);
      const receipts = new Map((state.sourceReads ?? []).map((item) => [item.id, item]));
      for (const id of selected) receipts.set(id, { id, readAt: now });
      state.sourceReads = [...receipts.values()];
      let updated = 0;
      for (const item of state.items) {
        if (!selected.has(item.id) || item.readAt !== null) continue;
        item.readAt = now;
        updated += 1;
      }
      applyNotificationRetention(state, transactionTime);
      return { updated, unreadCount: countUnreadNotifications(state) };
    });
  }

  get(id: string): Promise<WebNotification | null> {
    if (!isNotificationIdentifier(id)) throw new NotificationInputError("Invalid notification identity.");
    return this.transaction((state) => state.items.find((item) => item.id === id) ?? null);
  }

  getUnreadReplies(sessionId?: string): Promise<WebNotification[]> {
    return this.transaction((state) => {
      const overrides = new Set(state.manualUnreadIds ?? []);
      return state.items.filter((item) => isAutomaticUnreadReply(item, overrides, sessionId));
    });
  }

  markRepliesRead(ids: readonly string[], now = this.now()): Promise<NotificationReadResult> {
    if (!isNotificationTimestamp(now)) throw new NotificationInputError("Invalid notification read time.");
    if (ids.length > 1000) throw new NotificationInputError("Too many notification reply identities.");
    if (!ids.every(isNotificationIdentifier)) throw new NotificationInputError("Invalid notification reply identities.");
    const selected = new Set(ids);
    return this.transaction((state) => {
      const overrides = new Set(state.manualUnreadIds ?? []);
      let updated = 0;
      for (const item of state.items) {
        if (!selected.has(item.id)) continue;
        if (!isAutomaticUnreadReply(item, overrides)) continue;
        item.readAt = now;
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
