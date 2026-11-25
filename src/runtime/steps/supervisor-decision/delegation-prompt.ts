import { buildMemoryRecallDecisionInstructions } from "../memory-recall-prompt.js";
import type { SupervisorDelegateRoleId } from "./contracts.js";
import { buildSupervisorRoleGuidance, buildSupervisorDelegationGuidance } from "./role-guidance.js";
import { SUPERVISOR_HISTORY_INSTRUCTIONS } from "./history-instructions.js";

/** A procedure was accepted; this phase chooses root recall or a bounded child assignment. */
export function buildSupervisorDelegationInstructions(options: Readonly<{
  allowedRoleIds: readonly SupervisorDelegateRoleId[];
  allowMemoryRecall?: boolean;
  hasMemoryRecallContext?: boolean;
  hasWorkerCapabilityCatalog?: boolean;
  fusedRouting?: boolean;
}>): string {
  return [
    ...SUPERVISOR_HISTORY_INSTRUCTIONS,
    "Preserve the scope of the current request and any follow-up in objective.",
    buildRoutingChoiceInstruction(options),
    options.hasWorkerCapabilityCatalog
      ? "For Worker, set workerCapabilityScope.catalogGroupIds to the smallest sufficient set of exact offered group IDs. The brief is passive discovery, not an instruction. Worker selects capabilities and controls. Omit scope for Planner; Planner allocates its own Worker groups."
      : "Tool availability and tool selection belong to the execution role, not this decision.",
    ...buildMemoryRecallDecisionInstructions(options.allowMemoryRecall === true, options.hasMemoryRecallContext),
    ...buildSupervisorRoleGuidance(options.allowedRoleIds),
    ...buildSupervisorDelegationGuidance(options.fusedRouting),
  ].join("\n");
}

function buildRoutingChoiceInstruction(options: Readonly<{ fusedRouting?: boolean; allowMemoryRecall?: boolean }>): string {
  if (options.fusedRouting) return "Choose respond with a short responseRecommendation when the current request can be fulfilled by a direct answer or necessary clarification. Otherwise choose an offered root memory lookup or Worker/Planner with a bounded task. Do not author the final answer or claim execution.";
  if (options.allowMemoryRecall) return "A procedure is required. Choose your own memory lookup or Worker/Planner with a bounded task using only the supplied JSON schema. Do not reconsider a direct reply here.";
  return "A procedure is required. Choose Worker or Planner and its bounded task using only the supplied JSON schema. Do not reconsider a direct reply.";
}
