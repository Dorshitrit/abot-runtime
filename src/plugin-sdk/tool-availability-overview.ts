import type { ToolAvailabilityEntry } from "../plugin-contract/entrypoint.js";

export type ToolAvailabilityOverviewLevel = "detailed" | "titles" | "groups";

export type ToolAvailabilityOverviewGroup = Readonly<{
  groupId: string;
  memberCount: number;
  effects: readonly string[];
}>;

/** Complete informational candidates; callers own admission and context budget. */
export function buildToolAvailabilityOverview(
  entries: readonly ToolAvailabilityEntry[],
  groups: readonly ToolAvailabilityOverviewGroup[],
  level: ToolAvailabilityOverviewLevel,
): string {
  if (level === "detailed") return describeAvailableTools(entries);
  const orderedGroups = [...groups].sort((left, right) =>
    compareAscii(left.groupId, right.groupId),
  );
  if (level === "titles") return describeGroupTools(entries, orderedGroups);
  return orderedGroups.map(describeGroupMetadata).join("\n");
}

function describeAvailableTools(
  entries: readonly ToolAvailabilityEntry[],
): string {
  const tools = new Map<
    string,
    { operationIds: Set<string>; catalogGroups: Set<string> }
  >();
  for (const entry of entries) {
    const tool = tools.get(entry.toolName) ?? {
      operationIds: new Set<string>(),
      catalogGroups: new Set<string>(),
    };
    tool.operationIds.add(entry.operationId);
    for (const groupId of entry.catalogGroups) tool.catalogGroups.add(groupId);
    tools.set(entry.toolName, tool);
  }
  return [...tools.entries()]
    .sort(([left], [right]) => compareAscii(left, right))
    .map(
      ([toolName, tool]) =>
        `- ${formatOverviewIdentifier(toolName)} — ${sortedValues(tool.operationIds)} [${sortedValues(tool.catalogGroups)}]`,
    )
    .join("\n");
}

function describeGroupTools(
  entries: readonly ToolAvailabilityEntry[],
  groups: readonly ToolAvailabilityOverviewGroup[],
): string {
  return groups
    .map((group) => {
      const toolNames = new Set(
        entries
          .filter((entry) => entry.catalogGroups.includes(group.groupId))
          .map((entry) => entry.toolName),
      );
      return `- ${group.groupId}: ${sortedValues(toolNames)}`;
    })
    .join("\n");
}

function describeGroupMetadata(group: ToolAvailabilityOverviewGroup): string {
  return `- ${group.groupId} (memberCount=${group.memberCount}; effects=${sortedValues(group.effects)})`;
}

function sortedValues(values: Iterable<string>): string {
  return [...values]
    .sort(compareAscii)
    .map(formatOverviewIdentifier)
    .join(", ");
}

function formatOverviewIdentifier(value: string): string {
  if (isPlainOverviewIdentifier(value)) return value;
  return JSON.stringify(value)
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

function isPlainOverviewIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
