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
    "The exact current user request and its ordered active updates define the work to delegate. Use earlier conversation to resolve references and recover relevant source facts and constraints; earlier requests do not themselves create pending work or renewed authorization.",
    "Use an earlier request or proposal as active work only when the current request calls for it. Preserve the scope of that follow-up in objective; do not resume or repeat earlier actions merely because they appear in history.",
    options.allowMemoryRecall
      ? "A procedure is required. Choose your own memory lookup or Worker/Planner with a bounded task using only the supplied JSON schema. Do not reconsider a direct reply here. Tool availability and tool selection belong to the execution role, not this decision."
      : "A procedure is required. Choose Worker or Planner and its bounded task using only the supplied JSON schema. Do not reconsider a direct reply. Tool availability and tool selection belong to the execution role, not this decision.",
    ...buildMemoryRecallDecisionInstructions(options.allowMemoryRecall === true, options.hasMemoryRecallContext),
    ...buildSupervisorRoleGuidance(options.allowedRoleIds),
    ...buildSupervisorDelegationGuidance(),
  ].join("\n");
}
