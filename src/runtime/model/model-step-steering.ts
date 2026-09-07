import type { RequestSteeringInbox } from "../request/request-steering.js";

/** Returns a decision-bound invocation to its caller when that decision is stale. */
export class ModelStepSteeringSupersededError extends Error {
  constructor(readonly boundSteeringVersion: number) {
    super("model_step_steering_superseded");
    this.name = "ModelStepSteeringSupersededError";
  }
}

export function isModelStepSteeringSuperseded(
  error: unknown,
): error is ModelStepSteeringSupersededError {
  return error instanceof ModelStepSteeringSupersededError;
}

export function assertBoundModelStepSteeringCurrent(
  requestSteering: RequestSteeringInbox,
  boundSteeringVersion: number | undefined,
): void {
  if (boundSteeringVersion === undefined) return;
  if (requestSteering.isCurrent(boundSteeringVersion)) return;
  throw new ModelStepSteeringSupersededError(boundSteeringVersion);
}
