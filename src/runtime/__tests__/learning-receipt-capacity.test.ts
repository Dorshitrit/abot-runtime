import { describe, expect, it } from "vitest";
import type { LearningMemoryReceipt } from "../long-term-memory/maturation/contracts.js";
import { assertLearningReceiptCapacity, learningReviewAdmission, MAX_LEARNING_RECEIPTS } from "../long-term-memory/maturation/receipt-capacity.js";

const now = Date.parse("2026-09-25T10:00:00Z");
function receipt(batchId: string): LearningMemoryReceipt {
  return { batchId, recordIds: [], candidateIds: [], removedCandidateCount: 0,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() };
}

describe("bounded live learning receipts", () => {
  it("defers at the live count limit until expiry without removing replay evidence", () => {
    const records = Array.from({ length: MAX_LEARNING_RECEIPTS }, (_, index) => receipt(String(index)));
    const unchanged = JSON.stringify(records);
    expect(learningReviewAdmission(records, now)).toEqual({ available: false, reason: "learning_receipt_capacity", retryAt: "2026-09-25T10:01:00.000Z" });
    expect(() => assertLearningReceiptCapacity(records, receipt("new"), now)).toThrow("learning_receipt_capacity");
    expect(JSON.stringify(records)).toBe(unchanged);
    expect(learningReviewAdmission(records, now + 60_000)).toEqual({ available: true, retryAt: null });
  });

  it("bounds serialized UTF-8 bytes independently of receipt count", () => {
    const records = Array.from({ length: 300 }, (_, index) => ({ ...receipt(String(index)), recordIds: ["א".repeat(2000)] }));
    expect(learningReviewAdmission(records, now).available).toBe(false);
    expect(() => assertLearningReceiptCapacity(records, receipt("new"), now)).toThrow("learning_receipt_capacity");
  });

  it("allows headroom and rejects oversized individual receipts", () => {
    expect(learningReviewAdmission([receipt("old")], now)).toEqual({ available: true, retryAt: null });
    expect(() => assertLearningReceiptCapacity([receipt("old")], receipt("new"), now)).not.toThrow();
    expect(() => assertLearningReceiptCapacity([], receipt("x".repeat(9000)), now)).toThrow("learning_receipt_capacity");
  });
});
