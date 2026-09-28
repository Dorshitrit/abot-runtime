import { PASSIVE_OBSERVATION_RETENTION_MS } from "../../shared/passive-observation.js";
import type {
  ObservationMemoryReceipt,
  SaveObservationMemoryInput,
} from "./observation-contracts.js";

export function assertObservationBatchReplayable(
  input: Pick<SaveObservationMemoryInput, "batchExpiresAt">,
  now: number,
): void {
  const expiresAt = Date.parse(input.batchExpiresAt);
  if (!Number.isFinite(expiresAt))
    throw new Error("invalid_learning_batch_expiry");
  if (expiresAt <= now) throw new Error("learning_batch_expired");
}

export function retainReplayableObservationReceipts(
  receipts: readonly ObservationMemoryReceipt[],
  now: number,
): readonly ObservationMemoryReceipt[] {
  return receipts.filter((receipt) => {
    // Older receipts predate explicit deadlines. Their commit time is later
    // than evidence collection, so this fallback preserves every valid replay.
    const expiresAt = receipt.expiresAt
      ? Date.parse(receipt.expiresAt)
      : Date.parse(receipt.createdAt) + PASSIVE_OBSERVATION_RETENTION_MS;
    return expiresAt > now;
  });
}
