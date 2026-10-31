import type { RegisteredToolPayloadStage, RegisteredToolStagedPayloadPlan } from "../registered-tool-payload-plan.js";

/** Only a delegated final raw body may widen its selected target context. */
export function shouldPreserveFullBoundedTargetContext(
  params: Readonly<{
    preserveFullBoundedTargetContext?: boolean;
    call: Readonly<{ roleId: string }>;
    plan: RegisteredToolStagedPayloadPlan;
  }>,
  stage: RegisteredToolPayloadStage,
): boolean {
  if (params.preserveFullBoundedTargetContext !== true) return false;
  if (params.call.roleId !== "worker") return false;
  if (params.plan.stages.length < 2) return false;
  if (params.plan.stages.at(-1) !== stage) return false;
  if (stage.targetContext !== "bounded") return false;
  if (stage.responseFormat !== undefined) return false;
  return true;
}
