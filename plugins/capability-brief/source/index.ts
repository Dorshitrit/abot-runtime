import {
  buildToolAvailabilityBrief,
  defineRuntimePlugin,
  failureResult,
  successResult,
  type ToolExecutionContext,
} from "../../../src/plugin-sdk/index.js";

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

      const brief = buildToolAvailabilityBrief(availableTools);

      return successResult({
        output: brief.text,
        producedNewInformation: true,
        data: {
          source: "request_effective_tool_registry",
          toolOperationCount: availableTools.length,
          collection: brief.collection,
          output: brief.output,
          observationMeta: {
            kind: "stable_fact",
            carryPolicy: "never",
          },
        },
      });
    },
  },
}));
