import type {
  ToolActionSummary,
  ToolExecutionResult,
} from "../../../capabilities/tool-types.js";
import type { CapabilityResultReference } from "../../orchestration/capability-adapters/result.js";
import { projectTargetReferences } from "./result-references.js";

/** This exact envelope is both measured for the producer and captured for settlement. */
export function projectRegisteredToolResultEnvelope(
  result: ToolExecutionResult,
  completionActions: readonly ToolActionSummary[],
  selectedReferences: readonly CapabilityResultReference[] = [],
) {
  const references = projectTargetReferences([
    ...selectedReferences.map(({ target }) => target),
    ...completionActions.map(({ target }) => target),
  ]);
  return Object.freeze({
    kind: "registered_tool_execution_result_v1" as const,
    authority: "registered_plugin" as const,
    status: "executed" as const,
    result,
    ...(references.length ? { references } : {}),
  });
}
