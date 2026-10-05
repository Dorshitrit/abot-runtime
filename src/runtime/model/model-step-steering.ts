import type {
  RequestSteeringInbox,
  RequestSteeringSnapshot,
} from "../request/request-steering.js";

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

/** Internal control transfer, caught before it can leave the invocation loop. */
export class ModelStepAdmissionSuperseded extends Error {
  constructor(readonly steeringSnapshot: RequestSteeringSnapshot) {
    super("model_step_steering_superseded");
    this.name = "ModelStepAdmissionSuperseded";
  }
}

export function assertModelStepAdmissionCurrent(params: {
  abortSignal: AbortSignal;
  requestSteering: RequestSteeringInbox;
  boundSteeringVersion: number | undefined;
  ownsRequestSteering: boolean;
  steeringSnapshot: RequestSteeringSnapshot;
}): void {
  params.abortSignal.throwIfAborted();
  assertBoundModelStepSteeringCurrent(
    params.requestSteering,
    params.boundSteeringVersion,
  );
  if (!params.ownsRequestSteering) return;
  if (params.requestSteering.isCurrent(params.steeringSnapshot.version)) return;
  throw new ModelStepAdmissionSuperseded(params.steeringSnapshot);
}

export function isCompactionSteeringSuperseded(error: unknown): boolean {
  if (error instanceof ModelStepAdmissionSuperseded) return true;
  return isModelStepSteeringSuperseded(error);
}
