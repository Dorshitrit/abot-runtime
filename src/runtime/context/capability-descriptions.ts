import type { ToolAvailabilityEntry } from "../../capabilities/tool-types.js";

/** Complete request-registry facts; neither a selected subset nor tool schemas. */
export function buildCapabilityDescriptions(
  entries: readonly ToolAvailabilityEntry[],
): string {
  const ordered = [...entries].sort(compareCapabilityDescriptions);
  return JSON.stringify(
    ordered.map(({ toolName, operationId, summary, catalogGroups }) => ({
      toolName,
      operationId,
      summary,
      catalogGroups: [...new Set(catalogGroups)].sort(compareAscii),
    })),
  );
}

function compareCapabilityDescriptions(
  left: ToolAvailabilityEntry,
  right: ToolAvailabilityEntry,
): number {
  const byOperation = compareAscii(left.operationId, right.operationId);
  if (byOperation !== 0) return byOperation;
  return compareAscii(left.toolName, right.toolName);
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
