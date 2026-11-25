import { hasSuperContextContract } from "../../../context/super-context-policy.js";
import type { PreparedWorkerDecisionSession } from "./types.js";
import { projectWorkerControlsOutputType, WORKER_OUTPUT_TYPE_NOTATION } from "../fused-output-contract.js";

/** Invocation-local output guidance; never shared evidence or execution input. */
export function projectSuperWorkerControlsOutputContract(
  session: PreparedWorkerDecisionSession,
): string | undefined {
  if (!session.capabilitySelection.executionPending) return undefined;
  const authority = session.canonicalState.canonicalSource?.head.policy.authority;
  if (!authority) return undefined;
  if (!hasSuperContextContract(authority, "delegated.worker")) return undefined;
  return JSON.stringify({
    kind: "runtime_worker_controls_output_contract_v1",
    authority: "current_model_output_contract",
    applicability: "this_controls_refinement_only",
    frozenSelection: "Keep capability IDs, intent, authoringObjective and selectionControls fixed and out of output; retain every invocation_N slot in order.",
    presenceEffect: "Structure only; adds no execution requirement, permission or completion evidence.",
    notation: WORKER_OUTPUT_TYPE_NOTATION,
    outputType: projectWorkerControlsOutputType(session.contract.format),
  });
}
