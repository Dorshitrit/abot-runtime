import type { ChatMessage } from "../../../model-gateway/types.js";
import { createVerifiedCompactionProjection } from "../../context/verified-compaction-projection.js";
import { projectCanonicalRequestToolResult } from "../../context/canonical-capability-result.js";
import {
  createCapabilityResultCompactionSource,
  projectSingleCopyCapabilityResult,
} from "../../context/capability-result-compaction-source.js";
import type { RequestToolResultsView } from "../../context/request-tool-results.js";
import {
  buildExecutionControlsEvidenceMessage,
  type ControlsCompactionContext,
} from "./controls-compacted-evidence.js";
import { createSemanticCompactionSha256Fingerprint } from "../../context/semantic-compaction/contracts.js";
import type {
  CapabilityControls,
  CapabilityControlsSchema,
} from "../../orchestration/capability-adapters/index.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import type { RequestSteeringSnapshot } from "../../request/request-steering.js";
import {
  controlsEvidenceSelectionRejection,
  projectEligibleControlsEvidenceExecutionIds,
  requiresControlsEvidenceSelection,
} from "./controls-evidence-contract.js";

export type ControlsEvidenceAssignmentSlot = Readonly<{
  slot: string;
  capabilityId: string;
  operationObjective?: string;
  selectionControls: CapabilityControls;
  remainingControls: CapabilityControlsSchema;
  controlsEvidenceExecutionIds?: readonly string[];
  guidance: string;
}>;

/** Materializes only explicit choices; relevance remains the decision model's responsibility. */
export function projectSelectedControlsEvidence(
  params: Readonly<{
    requestId: string;
    head: RoleCallLedgerHead;
    call: RoleCallFrame;
    workingDirectory?: string;
    steering: RequestSteeringSnapshot;
    compaction?: ControlsCompactionContext;
    slots: readonly ControlsEvidenceAssignmentSlot[];
  }>,
): Readonly<{
  slots: readonly ControlsEvidenceAssignmentSlot[];
  messages: readonly ChatMessage[];
  view: RequestToolResultsView;
  scopeId: string;
  preservationObjective: string;
  hasVerifiedCompactedEvidence(messages: readonly ChatMessage[]): boolean;
}> {
  assertControlsEvidenceHead(params);
  const verifiedProjection = createVerifiedCompactionProjection();
  const eligible = projectEligibleControlsEvidenceExecutionIds(
    params.head,
    params.call,
  );
  const slots = freezeSelectedControlsSlots(params.slots, eligible);
  const selected = new Set(
    slots.flatMap((slot) => slot.controlsEvidenceExecutionIds ?? []),
  );
  const results = params.head.state.capabilityExecutions
    .filter((execution) => selected.has(execution.executionId))
    .map((execution) =>
      projectCanonicalRequestToolResult(params.head, execution),
    );
  const sources = results.map((result) => {
    const source = createCapabilityResultCompactionSource(result);
    if (
      source.content !==
      JSON.stringify(projectSingleCopyCapabilityResult(result))
    ) {
      throw new Error("execution_controls_evidence_source_bytes_invalid");
    }
    return source;
  });
  const view: RequestToolResultsView = Object.freeze({
    sourceRevision: params.head.revision,
    scope: Object.freeze({ kind: "call", callId: params.call.callId }),
    results: Object.freeze(results),
  });
  const preservationObjective = canonicalAssignmentJson({
    workingDirectory:
      params.workingDirectory ?? params.call.workingDirectory ?? null,
    invocations: slots.map(
      ({ guidance: _guidance, remainingControls: _schema, ...slot }) => slot,
    ),
  });
  const fingerprint = createSemanticCompactionSha256Fingerprint(
    canonicalAssignmentJson({
      contract: "execution_controls_evidence_v1",
      requestId: params.requestId,
      roleId: params.call.roleId,
      callId: params.call.callId,
      sourceRevision: params.head.revision,
      steering: params.steering,
      workingDirectory:
        params.workingDirectory ?? params.call.workingDirectory ?? null,
      slots,
      sources: sources.map(({ sourceRef, sourceFingerprint }) => ({
        sourceRef,
        sourceFingerprint,
      })),
    }),
  );
  return Object.freeze({
    slots,
    messages: Object.freeze(
      results.length > 0
        ? [
            buildExecutionControlsEvidenceMessage(view, {
              requestId: params.requestId,
              callId: params.call.callId,
              steering: params.steering,
              compaction: params.compaction,
              onVerifiedCompaction: verifiedProjection.record,
            }),
          ]
        : [],
    ),
    view,
    scopeId: `role:${params.call.roleId}:${params.call.callId}:controls-refinement:${fingerprint.slice(7)}`,
    preservationObjective,
    hasVerifiedCompactedEvidence: verifiedProjection.contains,
  });
}

function assertControlsEvidenceHead(
  params: Readonly<{
    requestId: string;
    head: RoleCallLedgerHead;
    call: RoleCallFrame;
  }>,
): void {
  if (params.head.state.requestId !== params.requestId)
    throw new Error("execution_controls_evidence_request_invalid");
  if (params.head.state.phase !== "running")
    throw new Error("execution_controls_evidence_head_invalid");
  if (params.head.state.rootCallId !== params.call.callId)
    throw new Error("execution_controls_evidence_call_invalid");
  if (params.head.state.activeCallId !== params.call.callId)
    throw new Error("execution_controls_evidence_call_invalid");
  if (params.call.parentCallId !== null)
    throw new Error("execution_controls_evidence_call_invalid");
  if (params.call.status !== "active")
    throw new Error("execution_controls_evidence_call_invalid");
  if (!params.head.state.calls.includes(params.call))
    throw new Error("execution_controls_evidence_call_binding_invalid");
}

function freezeSelectedControlsSlots(
  slots: readonly ControlsEvidenceAssignmentSlot[],
  eligible: readonly string[],
): readonly ControlsEvidenceAssignmentSlot[] {
  if (slots.length === 0)
    throw new Error("execution_controls_evidence_slots_empty");
  if (new Set(slots.map(({ slot }) => slot)).size !== slots.length)
    throw new Error("execution_controls_evidence_slot_duplicate");
  return Object.freeze(
    slots.map((slot) => {
      const requiresEvidence = requiresControlsEvidenceSelection({
        remainingSchema: slot.remainingControls,
      });
      if (!requiresEvidence) {
        if (slot.controlsEvidenceExecutionIds !== undefined)
          throw new Error("execution_controls_evidence_selection_unexpected");
        return Object.freeze({ ...slot });
      }
      if (
        controlsEvidenceSelectionRejection(
          slot.controlsEvidenceExecutionIds,
          eligible,
        )
      ) {
        throw new Error("execution_controls_evidence_selection_invalid");
      }
      const selected = new Set(slot.controlsEvidenceExecutionIds);
      return Object.freeze({
        ...slot,
        controlsEvidenceExecutionIds: Object.freeze(
          eligible.filter((id) => selected.has(id)),
        ),
      });
    }),
  );
}

function canonicalAssignmentJson(value: unknown): string {
  return JSON.stringify(canonicalAssignmentValue(value));
}

function canonicalAssignmentValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalAssignmentValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalAssignmentValue(record[key])]),
  );
}
