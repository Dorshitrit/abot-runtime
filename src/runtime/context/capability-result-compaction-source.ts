import type { RoleCallFrame, RoleCallLedgerHead } from "../orchestration/role-calls/index.js";
import type { CapabilityJsonObject } from "../orchestration/capability-adapters/result.js";
import type { RequestToolResult } from "./request-tool-results.js";
import { projectCanonicalRequestToolResult } from "./canonical-capability-result.js";
import { hasSuperContextContract } from "./super-context-policy.js";
import {
  createSemanticCompactionSha256Fingerprint,
  type SemanticCompactionSource,
} from "./semantic-compaction/contracts.js";

/** Capture full immutable bytes once, independently of the evidence consumer. */
export function createCapabilityResultCompactionSource(
  result: RequestToolResult,
): SemanticCompactionSource {
  if (!result.adapterResult)
    throw new Error("context_compaction_source_adapter_required");
  const exact = projectSingleCopyCapabilityResult(result);
  const content = JSON.stringify({
    executionId: exact.executionId,
    callId: exact.callId,
    invocationAttempt: exact.invocationAttempt,
    capabilityId: exact.capabilityId,
    declaredEffect: exact.declaredEffect,
    outcome: exact.outcome,
    observedEffect: exact.observedEffect,
    summary: exact.summary,
    ...(exact.referenceData ? { referenceData: exact.referenceData } : {}),
    ...(exact.references ? { references: exact.references } : {}),
    ...(exact.acceptedAction ? { acceptedAction: exact.acceptedAction } : {}),
    adapterResult: exact.adapterResult,
  });
  return Object.freeze({
    sourceRef: result.executionId,
    sourceFingerprint: createSemanticCompactionSha256Fingerprint(content),
    content,
  });
}

export function projectCanonicalCapabilityResultCompactionSources(params: {
  head: RoleCallLedgerHead;
  callId: string;
}): readonly SemanticCompactionSource[] {
  if (
    !hasSuperContextContract(params.head.policy.authority, "delegated.worker")
  ) {
    throw new Error("context_compaction_source_policy_invalid");
  }
  const call = params.head.state.calls.find(
    ({ callId }) => callId === params.callId,
  );
  if (!isCanonicalSuperCapabilitySourceCall(params.head, call))
    throw new Error("context_compaction_source_call_invalid");
  return Object.freeze(
    params.head.state.capabilityExecutions
      .filter(
        (execution) =>
          execution.callId === call.callId && execution.status === "settled",
      )
      .map((execution) =>
        createCapabilityResultCompactionSource(
          projectCanonicalRequestToolResult(params.head, execution),
        ),
      ),
  );
}

/** SUPER payloads may belong to a Worker or to the canonical Supervisor root. */
export function isCanonicalSuperCapabilitySourceCall(
  head: RoleCallLedgerHead,
  call: RoleCallFrame | undefined,
): call is RoleCallFrame {
  if (!call) return false;
  if (call.roleId === "worker") return true;
  if (call.roleId !== "supervisor") return false;
  if (call.callId !== head.state.rootCallId) return false;
  return call.parentCallId === null && call.depth === 0;
}

/** The existing visible Worker dedup rule also defines canonical source bytes. */
export function projectSingleCopyCapabilityResult(
  result: RequestToolResult,
): RequestToolResult {
  if (!isReferenceDataRepresentedByAdapterResult(result)) return result;
  const { referenceData: _referenceData, ...singleCopyResult } = result;
  return Object.freeze(singleCopyResult);
}

export function isReferenceDataRepresentedByAdapterResult(
  result: Pick<RequestToolResult, "referenceData" | "adapterResult">,
): boolean {
  const referenceData = result.referenceData;
  const adapterResult = result.adapterResult;
  if (!referenceData || !adapterResult) return false;
  if (adapterResult.kind === "registered_tool_execution_result_v1") {
    return adapterResult.result.output === referenceData;
  }
  if (adapterResult.kind !== "generic_capability_result_v1") return false;
  const payload = adapterResult.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    return false;
  return (payload as CapabilityJsonObject).referenceData === referenceData;
}
