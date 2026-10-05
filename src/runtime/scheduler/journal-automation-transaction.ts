import {
  AUTOMATION_COLLECTIONS,
  parseAutomationStoredRecord,
  type AutomationCollection,
  type AutomationJournalState,
  type AutomationStoredRecord,
} from "../automations/storage-records.js";

export type AutomationCollectionDelta = {
  upsert: AutomationStoredRecord[];
  deleted: string[];
  order?: string[];
};

export type AutomationTransaction = Partial<
  Record<AutomationCollection, AutomationCollectionDelta>
>;

function corruptTransaction(): never {
  throw new Error("scheduler_store_corrupt");
}

function requireIds(value: unknown): string[] {
  if (!Array.isArray(value)) corruptTransaction();
  if (!value.every((id) => typeof id === "string" && id.length > 0))
    corruptTransaction();
  if (new Set(value).size !== value.length) corruptTransaction();
  return [...value];
}

export function parseAutomationTransaction(
  value: unknown,
): AutomationTransaction {
  if (!value || typeof value !== "object" || Array.isArray(value))
    corruptTransaction();
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) => !AUTOMATION_COLLECTIONS.includes(key as AutomationCollection),
    )
  )
    corruptTransaction();
  const parsed: AutomationTransaction = {};
  for (const collection of AUTOMATION_COLLECTIONS) {
    const candidate = raw[collection];
    if (candidate === undefined) continue;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      corruptTransaction();
    const delta = candidate as Record<string, unknown>;
    if (!Array.isArray(delta.upsert)) corruptTransaction();
    const upsert = delta.upsert.map((record) =>
      parseAutomationStoredRecord(collection, record),
    );
    const deleted = requireIds(delta.deleted);
    const order =
      delta.order === undefined ? undefined : requireIds(delta.order);
    const ids = upsert.map((record) => record.id);
    if (new Set(ids).size !== ids.length) corruptTransaction();
    if (ids.some((id) => deleted.includes(id))) corruptTransaction();
    parsed[collection] = {
      upsert,
      deleted,
      ...(order === undefined ? {} : { order }),
    };
  }
  return parsed;
}

function changedRecords(
  before: readonly AutomationStoredRecord[],
  after: readonly AutomationStoredRecord[],
): AutomationStoredRecord[] {
  const originals = new Map(before.map((record) => [record.id, record]));
  return after.filter(
    (record) =>
      JSON.stringify(originals.get(record.id)) !== JSON.stringify(record),
  );
}

function changedOrder(
  before: readonly AutomationStoredRecord[],
  after: readonly AutomationStoredRecord[],
): string[] | undefined {
  const order = after.map((record) => record.id);
  if (before.length !== order.length) return order;
  return before.some((record, index) => record.id !== order[index])
    ? order
    : undefined;
}

export function automationTransaction(
  before: AutomationJournalState,
  after: AutomationJournalState,
): AutomationTransaction {
  const delta: AutomationTransaction = {};
  for (const collection of AUTOMATION_COLLECTIONS) {
    const previous = before[collection];
    const next = after[collection];
    const retained = new Set(next.map((record) => record.id));
    const deleted = previous
      .filter((record) => !retained.has(record.id))
      .map((record) => record.id);
    const upsert = changedRecords(previous, next);
    const order = changedOrder(previous, next);
    if (!upsert.length && !deleted.length && !order) continue;
    delta[collection] = {
      upsert,
      deleted,
      ...(order ? { order } : {}),
    };
  }
  return delta;
}

export function hasAutomationTransactionChanges(
  value: AutomationTransaction,
): boolean {
  return AUTOMATION_COLLECTIONS.some((collection) => {
    const delta = value[collection];
    return (
      !!delta &&
      (delta.upsert.length > 0 ||
        delta.deleted.length > 0 ||
        delta.order !== undefined)
    );
  });
}

export function hasAutomationRemovals(value: AutomationTransaction): boolean {
  return AUTOMATION_COLLECTIONS.some(
    (collection) => (value[collection]?.deleted.length ?? 0) > 0,
  );
}
