import { createHash } from "node:crypto";
import { NOTIFICATION_RETENTION_MS } from "./retention.js";
import { isIssueCounter, isIssueHash } from "./issue-schema.js";
import { hasOnlyNotificationFields as only, isNotificationRecord as record, isNotificationTimestamp as timestamp } from "./storage-fields.js";

export const ISSUE_RECEIPT_LIMIT = 10_000;
export type IssueReceipt = { hash: string; occurredAt: number };
export type NotificationIssueStorage = {
  sequence: number;
  receipts: IssueReceipt[];
  floor?: IssueReceipt;
  rejectedCount: number;
};

export function issueOccurrenceHash(namespace: string, occurrenceId: string): string {
  return createHash("sha256").update(JSON.stringify([namespace, occurrenceId])).digest("base64url");
}
export function compareIssueReceipts(left: IssueReceipt, right: IssueReceipt): number {
  return left.occurredAt - right.occurredAt || (left.hash < right.hash ? -1 : left.hash === right.hash ? 0 : 1);
}

function isReceipt(value: unknown): value is IssueReceipt {
  return record(value) && only(value, ["hash", "occurredAt"]) && isIssueHash(value.hash) && timestamp(value.occurredAt);
}

export function readIssueStorage(value: unknown): NotificationIssueStorage | undefined {
  if (value === undefined) return;
  if (!record(value) || !only(value, ["sequence", "receipts", "floor", "rejectedCount"]) ||
    !isIssueCounter(value.sequence) || !isIssueCounter(value.rejectedCount) || !Array.isArray(value.receipts) ||
    value.receipts.length > ISSUE_RECEIPT_LIMIT || !value.receipts.every(isReceipt) ||
    (value.floor !== undefined && !isReceipt(value.floor))) throw new Error("Invalid notification issue receipts.");
  const receipts = value.receipts as IssueReceipt[];
  if (new Set(receipts.map((item) => item.hash)).size !== receipts.length || receipts.some((item, index) =>
    (index > 0 && compareIssueReceipts(receipts[index - 1], item) >= 0) ||
    (value.floor !== undefined && compareIssueReceipts(item, value.floor as IssueReceipt) <= 0)))
    throw new Error("Invalid notification issue receipt ordering.");
  return value as NotificationIssueStorage;
}

/** A persisted floor excludes old duplicate AND real delayed events after bounded receipts are removed. */
export function pruneIssueReceipts(state: NotificationIssueStorage, now: number): void {
  state.receipts.sort(compareIssueReceipts);
  const expired = state.receipts.findIndex((receipt) => receipt.occurredAt > now - NOTIFICATION_RETENTION_MS);
  const expiredCount = expired === -1 ? state.receipts.length : expired;
  const removeCount = Math.max(expiredCount, state.receipts.length - ISSUE_RECEIPT_LIMIT);
  if (!removeCount) return;
  const removedFloor = state.receipts[removeCount - 1];
  if (!state.floor || compareIssueReceipts(removedFloor, state.floor) > 0) state.floor = removedFloor;
  state.receipts = state.receipts.slice(removeCount);
}

export function admitsIssueReceipt(state: NotificationIssueStorage, receipt: IssueReceipt, now: number): boolean {
  return receipt.occurredAt > now - NOTIFICATION_RETENTION_MS && receipt.occurredAt <= now &&
    (!state.floor || compareIssueReceipts(receipt, state.floor) > 0);
}
