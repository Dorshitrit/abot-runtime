import type { AutomationInputRecord } from "./storage-records.js";

const MAX_RETAINED_INPUT_RECORDS = 1_000;
const MAX_RETAINED_INPUT_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_AUTOMATION_INPUT_METADATA_BYTES = 32 * 1024 * 1024;
export const MAX_INPUT_SNAPSHOT_BYTES = 256 * 1024 * 1024;

/**
 * Baselines and consumed-version tombstones preserve exclusion and dedup history.
 * Retained snapshots share an environment budget. Complete history has a separate
 * per-automation budget, so one exhausted owner cannot stop unrelated intake.
 */
export function requireRetainedInputCapacity(records: readonly AutomationInputRecord[]): void {
  const retained = records.filter(hasRetainedInputSnapshot);
  const tooManyRetainedInputs = retained.length > MAX_RETAINED_INPUT_RECORDS;
  if (tooManyRetainedInputs) throw new Error("automation_source_capacity_exceeded");
  const retainedMetadataBytes = Buffer.byteLength(JSON.stringify(retained), "utf8");
  const retainedMetadataExceedsBudget = retainedMetadataBytes > MAX_RETAINED_INPUT_METADATA_BYTES;
  if (retainedMetadataExceedsBudget) throw new Error("automation_source_capacity_exceeded");
  const retainedSnapshotBytes = retained.reduce((bytes, record) =>
    bytes + (record.snapshot?.sizeBytes ?? 0), 0);
  const retainedSnapshotsExceedBudget = retainedSnapshotBytes > MAX_INPUT_SNAPSHOT_BYTES;
  if (retainedSnapshotsExceedBudget) throw new Error("automation_source_capacity_exceeded");
}

export function requireObservedInputCapacity(
  records: readonly AutomationInputRecord[],
  observedRecordIds: ReadonlySet<string>,
): void {
  requireRetainedInputCapacity(records);
  const observedOwners = new Set(records.filter((record) => observedRecordIds.has(record.id))
    .map((record) => record.automationId));
  for (const automationId of observedOwners) {
    const owned = records.filter((record) => record.automationId === automationId);
    const historyExceedsBudget = Buffer.byteLength(JSON.stringify(owned), "utf8") >
      MAX_AUTOMATION_INPUT_METADATA_BYTES;
    if (historyExceedsBudget) throw new Error("automation_source_capacity_exceeded");
  }
}

function hasRetainedInputSnapshot(record: AutomationInputRecord): boolean {
  return record.snapshot !== undefined;
}
