import type { LongTermMemoryRecord } from "./contracts.js";

/** Legacy records stay protected when their manual-edit history is unknown. */
export function canAutomaticallyManageMemory(
  record: LongTermMemoryRecord,
): boolean {
  if (record.provenance.kind === "manual") return false;
  return record.automaticManagement === "allowed";
}
