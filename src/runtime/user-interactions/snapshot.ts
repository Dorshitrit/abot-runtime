import {
  USER_INTERACTION_RECEIPT_LIMIT,
  USER_INTERACTION_TEXT_MAX_LENGTH,
  type PublishedUserInteraction,
  type UserInteractionSnapshot,
} from "./contracts.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null) return false;
  return typeof value === "object" && !Array.isArray(value);
}

export function isUserInteractionMessageText(text: unknown): text is string {
  if (typeof text !== "string") return false;
  if (text.trim().length === 0) return false;
  return text.length <= USER_INTERACTION_TEXT_MAX_LENGTH;
}

export function hasUserInteractionBinding(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.callId !== "string" || !value.callId.trim()) return false;
  if (!Number.isSafeInteger(value.activationCount) || Number(value.activationCount) < 1)
    return false;
  return Number.isSafeInteger(value.steeringVersion) && Number(value.steeringVersion) >= 0;
}

export function userInteractionId(requestId: string, sequence: number): string {
  return `${requestId}:interaction:${sequence}`;
}

/** Runs during construction and approval preflight, before resumed tool effects. */
export function restoreUserInteractionSnapshot(
  value: unknown,
  requestId: string,
): UserInteractionSnapshot | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("user_interaction_snapshot_invalid");
  if (!Number.isSafeInteger(value.publishedCount) || Number(value.publishedCount) < 1)
    throw new Error("user_interaction_snapshot_count_invalid");
  const count = Number(value.publishedCount);
  if (!Array.isArray(value.recent)) throw new Error("user_interaction_snapshot_receipts_invalid");
  if (value.recent.length !== Math.min(count, USER_INTERACTION_RECEIPT_LIMIT))
    throw new Error("user_interaction_snapshot_receipts_invalid");
  const receipts = value.recent;
  const recent = receipts.map((entry, index) =>
    restoreReceipt(entry, requestId, count - receipts.length + index + 1),
  );
  return Object.freeze({ publishedCount: count, recent: Object.freeze(recent) });
}

function restoreReceipt(
  value: unknown,
  requestId: string,
  sequence: number,
): PublishedUserInteraction {
  if (!isRecord(value)) throw new Error("user_interaction_receipt_invalid");
  if (value.version !== 1 || value.kind !== "message")
    throw new Error("user_interaction_receipt_kind_invalid");
  if (value.requestId !== requestId || value.sequence !== sequence)
    throw new Error("user_interaction_receipt_binding_invalid");
  if (value.interactionId !== userInteractionId(requestId, sequence))
    throw new Error("user_interaction_receipt_identity_invalid");
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)))
    throw new Error("user_interaction_receipt_time_invalid");
  if (!isRecord(value.payload) || !isUserInteractionMessageText(value.payload.text))
    throw new Error("user_interaction_receipt_text_invalid");
  if (!hasUserInteractionBinding(value.origin))
    throw new Error("user_interaction_receipt_origin_invalid");
  const origin = value.origin as PublishedUserInteraction["origin"];
  return Object.freeze({
    version: 1,
    interactionId: value.interactionId,
    requestId,
    sequence,
    createdAt: value.createdAt,
    kind: "message",
    payload: Object.freeze({ text: value.payload.text }),
    origin: Object.freeze({
      callId: origin.callId, activationCount: origin.activationCount,
      steeringVersion: origin.steeringVersion,
    }),
  });
}
