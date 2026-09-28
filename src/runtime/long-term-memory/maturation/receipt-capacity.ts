import type { LearningMemoryReceipt, LearningReviewAdmission } from "./contracts.js";

export const MAX_LEARNING_RECEIPTS = 4096;
export const MAX_LEARNING_RECEIPT_BYTES = 1024 * 1024;
const MAX_SINGLE_RECEIPT_BYTES = 8192;

/** Admission never removes live receipts: their replay protection is authoritative. */
export function learningReviewAdmission(receipts: readonly LearningMemoryReceipt[], now: number): LearningReviewAdmission {
  const live = receipts.filter((receipt) => Date.parse(receipt.expiresAt) > now);
  if (hasReviewReceiptSpace(live)) return { available: true, retryAt: null };
  let retryAt = Infinity;
  for (const receipt of live) retryAt = Math.min(retryAt, Date.parse(receipt.expiresAt));
  return { available: false, reason: "learning_receipt_capacity", retryAt: Number.isFinite(retryAt) ? new Date(retryAt).toISOString() : null };
}

/** Recheck at commit: simultaneous admissions must never overflow bounded storage. */
export function assertLearningReceiptCapacity(receipts: readonly LearningMemoryReceipt[], next: LearningMemoryReceipt, now: number): void {
  if (serializedBytes(next) > MAX_SINGLE_RECEIPT_BYTES) throw new Error("learning_receipt_capacity");
  const live = receipts.filter((receipt) => Date.parse(receipt.expiresAt) > now);
  if (live.length + 1 > MAX_LEARNING_RECEIPTS) throw new Error("learning_receipt_capacity");
  if (serializedBytes([...live, next]) > MAX_LEARNING_RECEIPT_BYTES) throw new Error("learning_receipt_capacity");
}

export function assertLearningReviewAdmitted(receipts: readonly LearningMemoryReceipt[], now: number): void {
  if (!learningReviewAdmission(receipts, now).available) throw new Error("learning_receipt_capacity");
}

function hasReviewReceiptSpace(live: readonly LearningMemoryReceipt[]): boolean {
  if (live.length >= MAX_LEARNING_RECEIPTS) return false;
  return serializedBytes(live) + MAX_SINGLE_RECEIPT_BYTES + 1 <= MAX_LEARNING_RECEIPT_BYTES;
}

function serializedBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
