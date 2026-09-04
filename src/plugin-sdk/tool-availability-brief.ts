import type { ToolAvailabilityEntry } from "../plugin-contract/entrypoint.js";
import {
  boundCollection,
  boundText,
  type BoundedCollectionMetadata,
  type BoundedTextMetadata,
} from "./bounds.js";

const TOOL_COUNT_MAX = 64;
const OUTPUT_CHARACTER_MAX = 16_000;

export type ToolAvailabilityBrief = Readonly<{
  text: string;
  collection: BoundedCollectionMetadata;
  output: BoundedTextMetadata;
}>;

/** Formats the existing bounded, on-demand tool brief without executing tools. */
export function buildToolAvailabilityBrief(
  entries: readonly ToolAvailabilityEntry[],
): ToolAvailabilityBrief {
  const orderedTools = [...entries].sort(compareAvailableTools);
  const boundedTools = boundCollection(orderedTools, {
    maxItems: TOOL_COUNT_MAX,
  });
  const rawOutput = [
    `Available tool operations: ${entries.length}`,
    ...boundedTools.items.map(formatAvailableTool),
    ...(boundedTools.metadata.truncated
      ? [
          `[${boundedTools.metadata.omittedItems} additional tool operations omitted]`,
        ]
      : []),
  ].join("\n");
  const boundedOutput = boundText(rawOutput, {
    maxChars: OUTPUT_CHARACTER_MAX,
    marker: "\n[available tool brief truncated]",
  });
  return Object.freeze({
    text: boundedOutput.text,
    collection: boundedTools.metadata,
    output: boundedOutput.metadata,
  });
}

function formatAvailableTool(tool: ToolAvailabilityEntry): string {
  return [
    `- ${tool.operationId}`,
    `(tool=${tool.toolName}; effect=${tool.effect}; groups=${tool.catalogGroups.join(",")})`,
    tool.summary,
  ].join(" ");
}

function compareAvailableTools(
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
