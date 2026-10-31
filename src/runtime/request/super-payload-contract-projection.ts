import { hasSuperContextContract } from "../context/super-context-policy.js";
import type { ExecutionPolicyAuthoritySnapshot } from "../orchestration/role-calls/index.js";
import type { WorkerCapabilityPayloadModelRequest } from "../orchestration/worker-capabilities/payload-contracts.js";

/** Promotes the captured stage contract without changing its internal sources. */
export function projectSuperPayloadContract(
  input: WorkerCapabilityPayloadModelRequest,
  authority: ExecutionPolicyAuthoritySnapshot | undefined,
  metadata: Readonly<Record<string, unknown>>,
): Readonly<{ instructions: string; metadata: Readonly<Record<string, unknown>> }> {
  const unchanged = { instructions: input.instructions, metadata };
  if (!authority || !hasSuperContextContract(authority, "delegated.worker")) return unchanged;
  const context = input.context;
  const stage = context.payloadStage;
  if (
    !("worker" in context) ||
    input.responseFormat !== undefined ||
    context.payloadContract.responseFormat !== undefined ||
    context.contextScope !== "target_with_artifacts" ||
    context.targetContext?.presentation !== "bounded" ||
    !stage ||
    !Number.isSafeInteger(stage.index) ||
    !Number.isSafeInteger(stage.count) ||
    stage.index < 2 ||
    stage.index !== stage.count ||
    (stage.contextScope !== undefined && stage.contextScope !== context.contextScope)
  ) return unchanged;
  const projectedContract = metadata.payloadContract;
  if (!projectedContract || typeof projectedContract !== "object" || Array.isArray(projectedContract)) return unchanged;
  const { instructions, ...remainingContract } = projectedContract as Readonly<Record<string, unknown>>;
  if (instructions !== context.payloadContract.instructions || typeof instructions !== "string") return unchanged;
  return Object.freeze({
    instructions: `${input.instructions}\n${instructions}`,
    metadata: Object.freeze({ ...metadata, payloadContract: Object.freeze(remainingContract) }),
  });
}
