import { isDeepStrictEqual } from "node:util";
import { readBoundRequestToolResultsView } from "./request-tool-results-message-binding.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { OperationSupervisionEvidenceEntry } from "./operation-supervision-evidence.js";
import {
  resolveCompactedOperationSupervisionEvidence,
  type OperationSupervisionCompaction,
} from "./operation-supervision-compacted-evidence.js";
import {
  assertOperationSupervisionEvidenceContext,
  readOperationSupervisionEvidenceBinding,
  rebindOperationSupervisionEvidenceMessage,
  type OperationSupervisionEvidenceContext,
} from "./operation-supervision-evidence-binding.js";

type ExactEvidence = Exclude<
  OperationSupervisionEvidenceEntry["evidence"],
  { kind: "existing_exact_capability_result_lane" }
>;
type RecordValue = Record<string, unknown>;

/** Resolve exact references against the final messages, before token admission. */
export function projectOperationSupervisionEvidenceClosure(
  messages: readonly ChatMessage[],
  context: OperationSupervisionEvidenceContext,
  compaction?: OperationSupervisionCompaction,
): ChatMessage[] {
  const origins = new Set<string>();
  return messages.map((message) => {
    const binding = readOperationSupervisionEvidenceBinding(message);
    if (!binding) return message;
    assertOperationSupervisionEvidenceContext(binding, context);
    const capsule = record(JSON.parse(message.content));
    const originals = JSON.parse(
      binding.exactEntriesJson,
    ) as OperationSupervisionEvidenceEntry[];
    const entries = originals.map((entry) => {
      assertExact(!origins.has(entry.originExecutionId));
      origins.add(entry.originExecutionId);
      const evidence = entry.evidence;
      if (evidence.kind === "existing_exact_capability_result_lane") {
        throw new Error("operation_supervision_evidence_exact_binding_invalid");
      }
      if (evidence.kind === "embedded_cross_call_exact_result") return entry;
      if (!hasExactLane(messages, entry.originExecutionId, evidence)) {
        const compacted = resolveCompactedOperationSupervisionEvidence(
          entry.originExecutionId,
          evidence,
          context,
          compaction,
        );
        return compacted ? { ...entry, evidence: compacted } : entry;
      }
      return {
        ...entry,
        evidence: {
          kind: "existing_exact_capability_result_lane" as const,
          executionId: entry.originExecutionId,
        },
      };
    });
    return rebindOperationSupervisionEvidenceMessage(
      message,
      JSON.stringify({ ...capsule, entries }),
    );
  });
}

function hasExactLane(
  messages: readonly ChatMessage[],
  executionId: string,
  expected: ExactEvidence,
): boolean {
  let nativeAction = false;
  let nativeResult = false;
  let projectedResult = false;
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        if (call.callId !== executionId) continue;
        const action = record(parse(call.arguments));
        const invocation = record(action?.invocation);
        assertExact(
          isExactNativeAction(action, invocation, executionId, expected),
        );
        assertExact(!nativeAction);
        nativeAction = true;
      }
    }
    if (message.role === "tool" && message.toolCallId === executionId) {
      const payload = record(parse(message.content));
      const result = record(payload?.result);
      assertExact(isExactNativeResult(payload, result, executionId, expected));
      assertExact(!nativeResult);
      nativeResult = true;
    }
    if (message.role !== "user" || !readBoundRequestToolResultsView(message))
      continue;
    const payload = record(parse(message.content));
    if (payload?.kind !== "runtime_request_tool_results_v1") continue;
    for (const value of Array.isArray(payload.results) ? payload.results : []) {
      const result = record(value);
      if (result?.executionId !== executionId) continue;
      // A summary-only receipt cannot satisfy an exact lane.
      if (result.acceptedAction !== undefined) {
        assertExact(
          isDeepStrictEqual(result.acceptedAction, expected.acceptedAction),
        );
      }
      if (result.adapterResult === undefined) continue;
      assertExact(isExactProjectedResult(result, expected));
      assertExact(!projectedResult);
      projectedResult = true;
    }
  }
  assertExact(nativeAction === nativeResult);
  assertExact(!(nativeResult && projectedResult));
  return (nativeAction && nativeResult) || projectedResult;
}

function isExactNativeAction(
  action: RecordValue | undefined,
  invocation: RecordValue | undefined,
  executionId: string,
  expected: ExactEvidence,
): boolean {
  const original = expected.acceptedAction;
  return (
    action?.kind === "runtime_execution_agent_action_v1" &&
    action.invocationAttempt === expected.receipt.invocationAttempt &&
    invocation?.executionId === executionId &&
    invocation.capabilityId === original.capabilityId &&
    invocation.declaredEffect === original.declaredEffect &&
    isDeepStrictEqual(invocation.controls, original.controls)
  );
}
function isExactNativeResult(
  payload: RecordValue | undefined,
  result: RecordValue | undefined,
  executionId: string,
  expected: ExactEvidence,
): boolean {
  return (
    payload?.kind === "runtime_execution_capability_result_v1" &&
    payload.invocationAttempt === expected.receipt.invocationAttempt &&
    result?.executionId === executionId &&
    result.capabilityId === expected.acceptedAction.capabilityId &&
    isDeepStrictEqual(result.adapterResult, expected.adapterResult)
  );
}
function isExactProjectedResult(
  result: RecordValue,
  expected: ExactEvidence,
): boolean {
  const receipt = expected.receipt;
  const matchesReceipt =
    result.callId === receipt.callId &&
    result.invocationAttempt === receipt.invocationAttempt &&
    result.capabilityId === receipt.capabilityId &&
    result.outcome === receipt.outcome &&
    result.declaredEffect === receipt.declaredEffect &&
    result.observedEffect === receipt.observedEffect &&
    result.summary === receipt.summary &&
    result.referenceData === receipt.referenceData &&
    isDeepStrictEqual(result.references, receipt.references);
  return (
    matchesReceipt &&
    isDeepStrictEqual(result.acceptedAction, expected.acceptedAction) &&
    isDeepStrictEqual(result.adapterResult, expected.adapterResult)
  );
}

function assertExact(valid: boolean): asserts valid {
  if (!valid)
    throw new Error("operation_supervision_evidence_exact_lane_invalid");
}
function parse(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}
