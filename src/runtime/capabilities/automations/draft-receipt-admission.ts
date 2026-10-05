import type { ToolNormalInvocationOperation } from "../../../capabilities/tool-types.js";
import { projectToolTargetReferences } from "../../adapters/registered-tool-worker-capabilities/result-evidence.js";
import {
  CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES,
  normalizeCapabilityAdapterResult,
  type CapabilityAdapterResultNormalization,
} from "../../orchestration/capability-adapters/result.js";

export class AutomationDraftReceiptCapacityError extends Error {
  readonly details = {
    code: "automation_authoring_receipt_too_large",
    message: "The complete draft is too large to return through model authoring. No changes were saved. Use Studio to inspect or edit large drafts.",
    maxResultBytes: CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES,
  } as const;

  constructor() { super("automation_authoring_receipt_too_large"); }
}

function isOversizedDraftReceipt(result: CapabilityAdapterResultNormalization): boolean {
  if (result.ok) return false;
  return result.code === "result_too_large";
}

/** Validate the complete result once, including references later added for a direct root. */
export function prepareAutomationDraftReceipt(
  receipt: unknown,
  admission: Readonly<{
    tool: "automation_builder" | "automations";
    operation: ToolNormalInvocationOperation;
    params: Readonly<Record<string, unknown>>;
    mutationEvidence: boolean;
  }>,
) {
  const output = { ok: true, output: JSON.stringify(receipt), producedNewInformation: true,
    data: { mutationEvidence: admission.mutationEvidence, currentStateEvidence: true } } as const;
  // These descriptors are only inputs to the existing target projector, never emitted actions.
  const selectedTargets = (admission.operation.selectionControlIds ?? []).map((key) => ({
    type: "selected_control",
    target: typeof admission.params[key] === "string" ? admission.params[key] : undefined,
  }));
  const references = projectToolTargetReferences(selectedTargets);
  const normalized = normalizeCapabilityAdapterResult({
    kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
    result: { ...output, tool: admission.tool, progress: false },
    ...(references.length > 0 ? { references } : {}),
  });
  if (normalized.ok) return output;
  if (isOversizedDraftReceipt(normalized)) throw new AutomationDraftReceiptCapacityError();
  throw new Error("automation_authoring_receipt_invalid");
}
