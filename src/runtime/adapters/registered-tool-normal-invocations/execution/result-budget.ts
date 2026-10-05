import {
  assessResultEnvelopeBytes,
  type ToolResultBudget,
} from "../../../../capabilities/result-budget.js";
import { buildToolCompletedEventActions } from "../../../../capabilities/tool-event-metadata.js";
import { measureToolContextTextBytes } from "../../../../capabilities/tool-context-text.js";
import { projectToolExecutionResult } from "../../../../capabilities/tool-result-normalization.js";
import type {
  ToolCall,
  ToolDefinition,
} from "../../../../capabilities/tool-types.js";
import type { CapabilityResultReference } from "../../../orchestration/capability-adapters/result.js";
import { projectRegisteredToolResultEnvelope } from "../../registered-tool-worker-capabilities/result-envelope.js";

/** Invocation-owned delivery contract; it grants no model context or execution authority. */
export function createRegisteredToolResultBudget(input: {
  call: ToolCall;
  definition: ToolDefinition;
  selectedReferences?: readonly CapabilityResultReference[];
}): ToolResultBudget {
  const selectedReferences = Object.freeze([
    ...(input.selectedReferences ?? []),
  ]);
  return Object.freeze({
    acceptsContextText: true,
    assess(output) {
      const result = projectToolExecutionResult(input.call.tool, output);
      const actions = buildToolCompletedEventActions(
        input.call,
        result,
        input.definition,
      );
      return assessResultEnvelopeBytes(
        projectRegisteredToolResultEnvelope(
          result,
          actions,
          selectedReferences,
        ),
        measureToolContextTextBytes(result),
      );
    },
  });
}

/** Metadata known before dispatch must leave space for even an empty result. */
export function assertRegisteredToolResultMetadataFits(
  budget: ToolResultBudget,
): void {
  const assessment = budget.assess({
    ok: true,
    output: "",
    producedNewInformation: false,
  });
  if (assessment.fits) return;
  throw new Error("registered_tool_result_metadata_exceeds_budget");
}
