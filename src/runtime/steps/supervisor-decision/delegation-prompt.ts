import { buildMemoryRecallDecisionInstructions } from "../memory-recall-prompt.js";
import type { SupervisorDelegateRoleId } from "./contracts.js";
import { buildSupervisorRoleGuidance, buildSupervisorDelegationGuidance } from "./role-guidance.js";

/** A procedure was accepted; this phase chooses root recall or a bounded child assignment. */
export function buildSupervisorDelegationInstructions(options: Readonly<{
  allowedRoleIds: readonly SupervisorDelegateRoleId[];
  allowMemoryRecall?: boolean;
  hasMemoryRecallContext?: boolean;
}>): string {
  return [
    options.allowMemoryRecall
      ? "A procedure is required. Choose your own memory lookup or Worker/Planner with a bounded task using only the supplied JSON schema. Do not reconsider a direct reply here. Tool availability and tool selection belong to the execution role, not this decision."
      : "A procedure is required. Choose Worker or Planner and its bounded task using only the supplied JSON schema. Do not reconsider a direct reply. Tool availability and tool selection belong to the execution role, not this decision.",
    ...buildMemoryRecallDecisionInstructions(options.allowMemoryRecall === true, options.hasMemoryRecallContext),
    ...buildSupervisorRoleGuidance(options.allowedRoleIds),
    ...buildSupervisorDelegationGuidance(),
  ].join("\n");
}
