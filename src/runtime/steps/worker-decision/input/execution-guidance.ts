import { buildBatchCapabilityExecutionGuidance } from "../../capability-execution-guidance.js";
import { workerCapabilityBatchExecutionSlotId } from "../format.js";
import type {
  WorkerSelectedCapabilityBatchExecution,
  WorkerSelectedCapabilityExecution,
} from "./types.js";

export function projectWorkerCapabilityExecutionGuidance(
  options: Readonly<{
    selectedCapabilityExecution?: WorkerSelectedCapabilityExecution;
    selectedCapabilityBatchExecution?: WorkerSelectedCapabilityBatchExecution;
  }>,
): readonly string[] {
  if (options.selectedCapabilityExecution) {
    return Object.freeze([
      "### SELECTED CAPABILITY EXECUTION GUIDANCE",
      options.selectedCapabilityExecution.guidance.length > 0
        ? options.selectedCapabilityExecution.guidance
        : "No additional execution guidance is supplied for this capability.",
      "### END SELECTED CAPABILITY EXECUTION GUIDANCE",
    ]);
  }
  if (options.selectedCapabilityBatchExecution) {
    return Object.freeze([
      "### SELECTED CAPABILITY BATCH EXECUTION GUIDANCE",
      ...buildBatchCapabilityExecutionGuidance(
        options.selectedCapabilityBatchExecution.invocations.map(
          ({ capabilityId, guidance }, index) => ({
            slot: workerCapabilityBatchExecutionSlotId(index),
            capabilityId,
            guidance,
            index,
          }),
        ),
        ({ index, capabilityId, guidance }) => [
          `#### Invocation ${index + 1}: ${capabilityId}`,
          guidance.length > 0
            ? guidance
            : "No additional execution guidance is supplied for this invocation.",
        ],
      ),
      "### END SELECTED CAPABILITY BATCH EXECUTION GUIDANCE",
    ]);
  }
  return Object.freeze([]);
}
