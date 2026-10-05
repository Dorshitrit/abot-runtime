import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  AUTOMATION_COLLECTIONS,
  emptyAutomationJournalState,
  type AutomationCollection,
  type AutomationJournalState,
  type AutomationStoredRecord,
} from "../automations/storage-records.js";
import {
  parseSchedulerTransaction,
  type SchedulerTransaction,
} from "./journal-transaction.js";
import type { AutomationTransaction } from "./journal-automation-transaction.js";

type JournalAutomationEntry = {
  id: string;
  file: string;
  offset: number;
  revision?: number;
  automationId?: string;
};

export type JournalAutomationIndexState = Record<
  AutomationCollection,
  JournalAutomationEntry[]
>;

function corruptIndex(): never {
  throw new Error("scheduler_store_corrupt");
}

export function emptyAutomationIndexState(): JournalAutomationIndexState {
  return {
    drafts: [],
    definitions: [],
    savedAgents: [],
    grants: [],
    inputs: [],
    executions: [],
    attempts: [],
    results: [],
  };
}

function recordRevision(
  collection: AutomationCollection,
  record: AutomationStoredRecord,
): number | undefined {
  if (collection === "drafts" && "storageRevision" in record &&
      record.storageRevision !== undefined)
    return record.storageRevision;
  if (collection === "grants" && "grantRevision" in record)
    return record.grantRevision;
  return "revision" in record ? record.revision : undefined;
}

function recordOwner(record: AutomationStoredRecord): string | undefined {
  return "automationId" in record ? record.automationId : undefined;
}

function hasValidTransactionReference(
  file: unknown,
  sequence: number,
): file is string {
  if (typeof file !== "string" || !/^[0-9]{16}\.json$/.test(file)) return false;
  const transaction = Number(file.slice(0, -5));
  return (
    Number.isSafeInteger(transaction) &&
    transaction >= 1 &&
    transaction <= sequence
  );
}

export function encodeAutomationIndexState(
  state: JournalAutomationIndexState,
): JournalAutomationIndexState {
  const encoded = emptyAutomationIndexState();
  for (const collection of AUTOMATION_COLLECTIONS) {
    encoded[collection] = state[collection].map((entry) => ({
      ...entry,
      file: basename(entry.file),
    }));
  }
  return encoded;
}

export function parseAutomationIndexState(
  value: unknown,
  directory: string,
  sequence: number,
): JournalAutomationIndexState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    corruptIndex();
  const raw = value as Record<string, unknown>;
  const parsed = emptyAutomationIndexState();
  for (const collection of AUTOMATION_COLLECTIONS) {
    const records = raw[collection];
    if (!Array.isArray(records)) corruptIndex();
    const seen = new Set<string>();
    parsed[collection] = records.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        corruptIndex();
      const entry = item as Record<string, unknown>;
      if (typeof entry.id !== "string" || !entry.id) corruptIndex();
      if (seen.has(entry.id)) corruptIndex();
      seen.add(entry.id);
      if (!hasValidTransactionReference(entry.file, sequence)) corruptIndex();
      if (!Number.isSafeInteger(entry.offset) || Number(entry.offset) < 0)
        corruptIndex();
      if (
        entry.revision !== undefined &&
        (!Number.isSafeInteger(entry.revision) || Number(entry.revision) < 1)
      )
        corruptIndex();
      if (
        entry.automationId !== undefined &&
        (typeof entry.automationId !== "string" || !entry.automationId)
      )
        corruptIndex();
      return {
        id: entry.id,
        file: join(directory, entry.file),
        offset: Number(entry.offset),
        ...(entry.revision === undefined
          ? {}
          : { revision: Number(entry.revision) }),
        ...(entry.automationId === undefined
          ? {}
          : { automationId: entry.automationId }),
      };
    });
  }
  if (
    Object.keys(raw).some(
      (key) => !AUTOMATION_COLLECTIONS.includes(key as AutomationCollection),
    )
  )
    corruptIndex();
  return parsed;
}

export class JournalAutomationIndex {
  private readonly records = new Map<
    AutomationCollection,
    Map<string, JournalAutomationEntry>
  >();

  constructor(state = emptyAutomationIndexState()) {
    for (const collection of AUTOMATION_COLLECTIONS) {
      this.records.set(
        collection,
        new Map(state[collection].map((entry) => [entry.id, entry])),
      );
    }
  }

  exportState(): JournalAutomationIndexState {
    const state = emptyAutomationIndexState();
    for (const collection of AUTOMATION_COLLECTIONS)
      state[collection] = structuredClone([
        ...this.collection(collection).values(),
      ]);
    return state;
  }

  validate(transaction: AutomationTransaction): void {
    for (const collection of AUTOMATION_COLLECTIONS) {
      const delta = transaction[collection];
      if (!delta) continue;
      const before = this.collection(collection);
      const next = new Map(before);
      for (const id of delta.deleted) next.delete(id);
      for (const record of delta.upsert) {
        const previous = before.get(record.id);
        const revision = recordRevision(collection, record);
        if (
          previous?.automationId &&
          previous.automationId !== recordOwner(record)
        )
          corruptIndex();
        if (
          previous &&
          ["definitions", "savedAgents", "results"].includes(collection)
        )
          corruptIndex();
        if (
          previous?.revision !== undefined &&
          revision !== undefined &&
          revision <= previous.revision
        )
          corruptIndex();
        next.set(record.id, {
          id: record.id,
          file: "",
          offset: 0,
          ...(revision === undefined ? {} : { revision }),
          ...(recordOwner(record) === undefined
            ? {}
            : { automationId: recordOwner(record) }),
        });
      }
      if (delta.order && !containsEveryEntry(next, delta.order)) corruptIndex();
    }
  }

  apply(transaction: AutomationTransaction, file: string): void {
    this.validate(transaction);
    for (const collection of AUTOMATION_COLLECTIONS) {
      const delta = transaction[collection];
      if (!delta) continue;
      const entries = this.collection(collection);
      for (const id of delta.deleted) entries.delete(id);
      delta.upsert.forEach((record, offset) => {
        entries.set(record.id, {
          id: record.id,
          file,
          offset,
          ...(recordRevision(collection, record) === undefined
            ? {}
            : { revision: recordRevision(collection, record) }),
          ...(recordOwner(record) === undefined
            ? {}
            : { automationId: recordOwner(record) }),
        });
      });
      if (!delta.order) continue;
      this.records.set(
        collection,
        new Map(delta.order.map((id) => [id, entries.get(id)!])),
      );
    }
  }

  async snapshot(): Promise<AutomationJournalState> {
    const state = emptyAutomationJournalState();
    const files = new Map<string, Promise<SchedulerTransaction>>();
    for (const collection of AUTOMATION_COLLECTIONS) {
      for (const entry of this.collection(collection).values()) {
        let loaded = files.get(entry.file);
        if (!loaded) {
          loaded = readFile(entry.file, "utf8").then((text) =>
            parseSchedulerTransaction(JSON.parse(text)),
          );
          files.set(entry.file, loaded);
        }
        const record = (await loaded).automation?.[collection]?.upsert[
          entry.offset
        ];
        if (!record || record.id !== entry.id) corruptIndex();
        if (recordRevision(collection, record) !== entry.revision)
          corruptIndex();
        if (recordOwner(record) !== entry.automationId) corruptIndex();
        (state[collection] as AutomationStoredRecord[]).push(
          structuredClone(record),
        );
      }
    }
    return state;
  }

  private collection(
    collection: AutomationCollection,
  ): Map<string, JournalAutomationEntry> {
    return this.records.get(collection)!;
  }
}

function containsEveryEntry(
  entries: Map<string, JournalAutomationEntry>,
  order: string[],
): boolean {
  if (entries.size !== order.length) return false;
  if (new Set(order).size !== order.length) return false;
  return order.every((id) => entries.has(id));
}
