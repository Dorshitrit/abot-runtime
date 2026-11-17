import { MODEL_STEPS } from "../../../shared/model-steps.js";
import { createModelStepCompactionController } from "../../context/model-step-compaction.js";
import { createExecutionHistoryReferenceCompactionController } from "../../context/session-memory/execution-reference-memory.js";
import type { FilePayloadInput } from "./binding.js";
import type { buildFilePayloadInput, FilePayloadRequest } from "./context.js";

/** A file preparation keeps its own continuation; root evidence is reused separately. */
export function createFilePayloadCompactionController(
  request: FilePayloadRequest,
  input: FilePayloadInput,
  projection: ReturnType<typeof buildFilePayloadInput>,
) {
  const modelStep = MODEL_STEPS.EXECUTION_FILE_PAYLOAD_RAW;
  const active = createModelStepCompactionController(request, {
    call: { roleId: "root", callId: input.call.callId, objective: input.authoringObjective! },
    consumer: modelStep,
    allowedConsumers: [modelStep],
    scopeId: `payload:${input.call.callId}:${input.executionId}:0`,
    sourceRevision: Math.max(input.call.activationCount, input.settledCapabilityResults.length),
    resultSourceOverrides: projection.resultSourceOverrides,
    hasVerifiedCompactedEvidence: projection.hasVerifiedCompactedEvidence,
  });
  return createExecutionHistoryReferenceCompactionController(request, projection.historyMemory, active);
}
