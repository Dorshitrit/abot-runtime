import { CORE_TOOL_CONTRACTS } from "../capabilities/core-tool-contracts.js";
import type { CapabilityAdapterResult } from "../orchestration/capability-adapters/index.js";

/** Classify canonical core reads before a consumer discards tool provenance. */
export function isSuccessfulCoreSkillRead(
  capabilityId: string,
  outcome: "succeeded" | "failed" | null,
  result?: CapabilityAdapterResult,
): boolean {
  if (outcome !== "succeeded") return false;
  if (capabilityId !== "read_skill" && capabilityId !== "read_skills")
    return false;
  if (result?.kind !== "registered_tool_execution_result_v1") return false;
  if (result.result.tool !== CORE_TOOL_CONTRACTS.skills.name) return false;
  return result.result.ok;
}
