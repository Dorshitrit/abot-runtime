import {
  boundCollection,
  boundText,
  defineRuntimePlugin,
  failureResult,
  successResult,
  type ToolAvailabilityEntry,
  type ToolExecutionContext,
} from "../../../src/plugin-sdk/index.js";

const TOOL_COUNT_MAX = 64;
const OUTPUT_CHARACTER_MAX = 16_000;

export default defineRuntimePlugin(() => ({
  handlers: {
    async capability_brief(
      _params: Record<string, unknown>,
      executionContext?: ToolExecutionContext,
    ) {
      const availableTools = executionContext?.sharedState?.availableTools;
      if (availableTools === undefined) {
        return failureResult({
          errorCode: "available_tool_catalog_unavailable",
          message: "The request-effective tool catalog is unavailable.",
        });
      }

      const orderedTools = [...availableTools].sort(compareAvailableTools);
      const boundedTools = boundCollection(orderedTools, {
        maxItems: TOOL_COUNT_MAX,
      });
      const rawOutput = [
        `Available tool operations: ${availableTools.length}`,
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

      return successResult({
        output: boundedOutput.text,
        producedNewInformation: true,
        data: {
          source: "request_effective_tool_registry",
          toolOperationCount: availableTools.length,
          collection: boundedTools.metadata,
          output: boundedOutput.metadata,
          observationMeta: {
            kind: "stable_fact",
            carryPolicy: "never",
          },
        },
      });
    },
  },
}));

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
  return byOperation !== 0
    ? byOperation
    : compareAscii(left.toolName, right.toolName);
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
