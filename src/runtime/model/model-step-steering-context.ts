import type { ModelStep } from "../../shared/model-steps.js";
import type { RequestSteeringSnapshot } from "../request/request-steering.js";

type InvocationSteering = Readonly<{
  modelStep: ModelStep;
  boundSteeringVersion?: number;
  callerSteering?: RequestSteeringSnapshot;
}>;

/** Caller authority is projected only on the decision that received the handoff. */
export function resolveInvocationSteeringContext(
  params: InvocationSteering,
  ownsRequestSteering: boolean,
  current: RequestSteeringSnapshot,
): RequestSteeringSnapshot | undefined {
  if (!params.callerSteering) return ownsRequestSteering ? current : undefined;
  if (params.modelStep !== "planner.decision")
    throw new Error("caller_steering_consumer_invalid");
  if (params.boundSteeringVersion !== params.callerSteering.version)
    throw new Error("caller_steering_binding_invalid");
  return params.callerSteering;
}

export function modelStepSteeringDisposition(
  params: InvocationSteering,
  ownsRequestSteering: boolean,
): string {
  if (ownsRequestSteering) return "supervisor_owned";
  if (params.callerSteering) return "caller_owned";
  if (params.boundSteeringVersion !== undefined) return "yield_to_caller";
  return "deferred_to_supervisor";
}

/** Legacy unbound roles retain their policy; bound Worker outputs never defer. */
export function isUnboundSteeringDeferred(
  ownsRequestSteering: boolean,
  boundSteeringVersion: number | undefined,
): boolean {
  if (ownsRequestSteering) return false;
  return boundSteeringVersion === undefined;
}
