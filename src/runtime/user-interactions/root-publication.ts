import { traceDebug } from "../observability/debug-logger.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import type { RootDecisionActivation } from "../request/root-execution-contracts.js";
import { resolveRequestSteeringInbox } from "../request/request-steering.js";

/** The shared kernel accepts presentation; each root adapter chooses its model contract. */
export function publishRootUserInteraction(
  request: RequestExecutionScope,
  activation: RootDecisionActivation,
): boolean {
  const proposal = activation.interaction;
  if (!proposal) return true;
  request.abortSignal.throwIfAborted();
  const supported = request.executionPolicy.rootContract.supportedInteractionKinds;
  if (!supported?.includes(proposal.kind))
    throw new Error("root_user_interaction_not_supported");
  if (!canPublishContinuingRootInteraction(activation))
    throw new Error("root_user_interaction_requires_continuation");
  if (!resolveRequestSteeringInbox(request.requestSteering).isCurrent(
    activation.decisionSteeringVersion,
  )) {
    traceDebug("runtime.user_interactions", "proposal.superseded", {
      requestId: request.requestId, callId: activation.call.callId,
      activationCount: activation.call.activationCount,
      decisionSteeringVersion: activation.decisionSteeringVersion,
      currentSteeringVersion: resolveRequestSteeringInbox(request.requestSteering).snapshot().version,
    });
    return false;
  }
  if (!request.userInteractions) throw new Error("request_user_interactions_unavailable");
  request.userInteractions.publish(proposal, {
    callId: activation.call.callId,
    activationCount: activation.call.activationCount,
    steeringVersion: activation.decisionSteeringVersion,
  });
  return true;
}

function canPublishContinuingRootInteraction(activation: RootDecisionActivation): boolean {
  if (activation.decision.action === "respond") return false;
  if (activation.decision.action === "blocked") return false;
  return activation.decision.action !== "reconsider_capability_selection";
}
