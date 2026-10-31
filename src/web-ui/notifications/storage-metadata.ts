import { NOTIFICATION_HISTORY_LIMIT, NOTIFICATION_TOMBSTONE_LIMIT } from "./retention.js";
import type { NotificationReadChange } from "./contracts.js";
import {
  hasOnlyNotificationFields, isNotificationIdentifier, isNotificationRecord,
  isNotificationTimestamp,
} from "./storage-fields.js";
import type { NotificationStoreState } from "./storage-schema.js";

export type NotificationSourceRead = { id: string; readAt: number };
export type NotificationTombstone = { id: string; retiredAt: number };
export type NotificationStorageMetadata = {
  sourceReads?: NotificationSourceRead[];
  manualUnreadIds?: string[];
  tombstones?: NotificationTombstone[];
  readSyncInitialized?: true;
};

/** Private receipts stay bounded independently of the visible history. */
export function readNotificationStorageMetadata(value: Record<string, unknown>): NotificationStorageMetadata {
  const { manualUnreadIds, tombstones, readSyncInitialized, sourceReads } = value;
  if (sourceReads !== undefined && !isSourceReadList(sourceReads))
    throw new Error("Invalid notification source read receipts.");
  if (manualUnreadIds !== undefined && !isManualUnreadList(manualUnreadIds))
    throw new Error("Invalid notification unread overrides.");
  if (tombstones !== undefined && !isTombstoneList(tombstones))
    throw new Error("Invalid notification deduplication receipts.");
  if (readSyncInitialized !== undefined && readSyncInitialized !== true)
    throw new Error("Invalid notification read synchronization metadata.");
  return {
    ...(sourceReads === undefined ? {} : { sourceReads: sourceReads as NotificationSourceRead[] }),
    ...(manualUnreadIds === undefined ? {} : { manualUnreadIds: manualUnreadIds as string[] }),
    ...(tombstones === undefined ? {} : { tombstones: tombstones as NotificationTombstone[] }),
    ...(readSyncInitialized === undefined ? {} : { readSyncInitialized }),
  };
}

function isSourceReadList(value: unknown): value is NotificationSourceRead[] {
  if (!Array.isArray(value) || value.length > NOTIFICATION_HISTORY_LIMIT) return false;
  if (!value.every((item) => isNotificationRecord(item) &&
    hasOnlyNotificationFields(item, ["id", "readAt"]) &&
    isNotificationIdentifier(item.id) && isNotificationTimestamp(item.readAt))) return false;
  return new Set(value.map((item) => item.id)).size === value.length;
}

function isManualUnreadList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  if (value.length > NOTIFICATION_HISTORY_LIMIT) return false;
  if (!value.every(isNotificationIdentifier)) return false;
  return new Set(value).size === value.length;
}

function isTombstoneList(value: unknown): value is NotificationTombstone[] {
  if (!Array.isArray(value)) return false;
  if (value.length > NOTIFICATION_TOMBSTONE_LIMIT) return false;
  if (!value.every(isNotificationTombstone)) return false;
  return new Set(value.map((item) => item.id)).size === value.length;
}

function isNotificationTombstone(value: unknown): value is NotificationTombstone {
  if (!isNotificationRecord(value)) return false;
  if (!hasOnlyNotificationFields(value, ["id", "retiredAt"])) return false;
  return isNotificationIdentifier(value.id) && isNotificationTimestamp(value.retiredAt);
}

export function applyExplicitNotificationReadOverride(state: NotificationStoreState, change: NotificationReadChange): void {
  const overrides = new Set(state.manualUnreadIds ?? []);
  const selected = "ids" in change ? new Set(change.ids) : null;
  for (const item of state.items) {
    if (selected && !selected.has(item.id)) continue;
    if (change.read) overrides.delete(item.id);
    else overrides.add(item.id);
  }
  if (overrides.size || state.manualUnreadIds !== undefined) state.manualUnreadIds = [...overrides];
}

/** Legacy unread intent is ambiguous, so preserve it before accepting new records. */
export function initializeNotificationReadSynchronization(state: NotificationStoreState): void {
  if (state.readSyncInitialized === true) return;
  const overrides = new Set(state.manualUnreadIds ?? []);
  for (const item of state.items) {
    if (item.readAt === null) overrides.add(item.id);
  }
  state.manualUnreadIds = [...overrides];
  state.readSyncInitialized = true;
}
