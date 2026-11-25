import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelGatewayClient } from "../../ports.js";

type EvidenceInput = Parameters<ModelGatewayClient["invoke"]>[0];

/** The scenario explicitly owns readiness; this builder only supplies the actual bound references. */
export function workerEvidenceDecision(
  input: EvidenceInput,
  requiresExecution: boolean,
  established = "",
  remaining = requiresExecution ? "The assigned outcome still requires execution." : "",
) {
  if (input.modelStep !== "worker.evidence") throw new Error("fixture_worker_evidence_step_required");
  return { requiresExecution, established, remaining, evidenceRefs: evidenceReferences(input) };
}

export function workerEvidenceReply(
  input: EvidenceInput,
  requiresExecution: boolean,
  established?: string,
  remaining?: string,
) {
  return { text: JSON.stringify({ decision: workerEvidenceDecision(input, requiresExecution, established, remaining) }), meta: {} };
}

/** Build one real fused call from the scenario's explicit selection and actual bound evidence. */
export function workerFusedDecision(
  input: EvidenceInput,
  selection: Readonly<{ action: string; [key: string]: unknown }>,
  established = "",
  remaining = selection.action === "return_result" ? "" : "The assigned outcome still requires execution.",
) {
  if (input.modelStep !== "worker.decision" || typeof input.format !== "object" ||
      input.format.name !== "worker_evidence_and_selection")
    throw new Error("fixture_worker_fused_step_required");
  return {
    assessment: { requiresExecution: selection.action !== "return_result", established, remaining, evidenceRefs: evidenceReferences(input) },
    selection,
  };
}

export function workerFusedReply(...args: Parameters<typeof workerFusedDecision>) {
  return { text: JSON.stringify({ decision: workerFusedDecision(...args) }), meta: {} };
}

function evidenceReferences(input: EvidenceInput): readonly string[] {
  for (const message of input.messages as readonly ChatMessage[]) {
    let value: unknown;
    try { value = JSON.parse(message.content); } catch { continue; }
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (record.kind !== "runtime_worker_evidence_assignment_v1") continue;
    if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.some((ref) => typeof ref !== "string"))
      throw new Error("fixture_worker_evidence_references_invalid");
    return record.evidenceRefs;
  }
  throw new Error("fixture_worker_evidence_assignment_missing");
}
