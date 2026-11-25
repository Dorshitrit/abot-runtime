import { FILE_PAYLOAD_TOOL_HANDOFF, type FilePayloadToolHandoff } from "../../capabilities/file-payload-tool-handoff.js";
import { requireCapabilityAdapterResult } from "./result-observer.js";
import type { prepareOperationPayload } from "./payload-lifecycle.js";
import type { payloadRejection } from "./payload-rejection.js";
import { createRegisteredToolWorkerFailureOutcomeFingerprint } from "./failure-outcome-fingerprint.js";

/** The original mutation is unexecuted; its continuation is committed with this receipt. */
export function bindFilePayloadToolHandoff(
  params: Parameters<typeof prepareOperationPayload>[0],
  handoff: FilePayloadToolHandoff,
  rejected: ReturnType<typeof payloadRejection>,
): ReturnType<typeof payloadRejection> {
  if (rejected.sourceIssueCode !== handoff.code) return rejected;
  if (params.executionFreshness?.token.kind !== "request_steering_v1") return rejected;
  const exactResult = requireCapabilityAdapterResult({
    kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed", ok: false,
    payload: { ...rejected.exactResult, fileAuthoringContinuation: {
      kind: FILE_PAYLOAD_TOOL_HANDOFF,
      invocationAttempt: params.call.activationCount,
      steeringVersion: params.executionFreshness.token.version,
      pending: { capabilityId: params.descriptor.capabilityId, controls: params.controls,
        authoringObjective: params.authoringObjective },
      toolDecision: handoff.selection,
    } },
  });
  return Object.freeze({ ...rejected, exactResult, result: Object.freeze({
    ...rejected.result,
    failureOutcomeFingerprint: createRegisteredToolWorkerFailureOutcomeFingerprint(requireCapabilityAdapterResult({
      kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed", ok: false,
      payload: { code: handoff.code, toolDecision: handoff.selection },
    })),
  }) });
}
