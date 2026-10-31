import type { WebNotification } from "./contracts.js";
import type { NotificationTombstone } from "./storage-metadata.js";
import type { NotificationStoreState } from "./storage-schema.js";

export const NOTIFICATION_HISTORY_LIMIT = 1000;
export const NOTIFICATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const NOTIFICATION_TOMBSTONE_LIMIT = 1000;

function compareIdentity(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareEvictionOrder(left: WebNotification, right: WebNotification): number {
  return Number(left.readAt === null) - Number(right.readAt === null) ||
    left.createdAt - right.createdAt || compareIdentity(left.id, right.id);
}

function isExpiredNotification(item: WebNotification, now: number): boolean {
  return item.createdAt <= now - NOTIFICATION_RETENTION_MS;
}

function isRetainedTombstone(item: NotificationTombstone, retainedIds: Set<string>, now: number): boolean {
  if (retainedIds.has(item.id)) return false;
  return item.retiredAt > now - NOTIFICATION_RETENTION_MS;
}

function retainBoundedMetadata(state: NotificationStoreState, removed: WebNotification[], now: number): void {
  if (state.sourceReads !== undefined) {
    state.sourceReads = state.sourceReads
      .filter((item) => item.readAt > now - NOTIFICATION_RETENTION_MS)
      .sort((left, right) => right.readAt - left.readAt || compareIdentity(right.id, left.id))
      .slice(0, NOTIFICATION_HISTORY_LIMIT);
  }
  const retainedIds = new Set(state.items.map((item) => item.id));
  if (state.manualUnreadIds !== undefined)
    state.manualUnreadIds = state.manualUnreadIds.filter((id) => retainedIds.has(id));
  const receipts = new Map((state.tombstones ?? [])
    .filter((item) => isRetainedTombstone(item, retainedIds, now))
    .map((item) => [item.id, item]));
  for (const item of removed) {
    if (!receipts.has(item.id)) receipts.set(item.id, { id: item.id, retiredAt: now });
  }
  if (receipts.size || state.tombstones !== undefined) {
    state.tombstones = [...receipts.values()]
      .sort((left, right) => right.retiredAt - left.retiredAt || compareIdentity(right.id, left.id))
      .slice(0, NOTIFICATION_TOMBSTONE_LIMIT);
  }
}

/** Runs inside the store transaction; pending deliveries have no retention exemption. */
export function applyNotificationRetention(state: NotificationStoreState, now: number): void {
  const expired = state.items.filter((item) => isExpiredNotification(item, now));
  const live = state.items.filter((item) => !isExpiredNotification(item, now));
  const overflow = Math.max(0, live.length - NOTIFICATION_HISTORY_LIMIT);
  const removed = [...expired, ...[...live].sort(compareEvictionOrder).slice(0, overflow)];
  const removedIds = new Set(removed.map((item) => item.id));
  state.items = live.filter((item) => !removedIds.has(item.id));
  retainBoundedMetadata(state, removed, now);
}
