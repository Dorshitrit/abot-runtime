import { isDeepStrictEqual } from "node:util";
import type { WorkerCapabilityExecutionFreshness } from "../orchestration/worker-capabilities/contracts.js";
import {
  projectRequestSteeringSnapshot,
  resolveRequestSteeringInbox,
} from "./request-steering.js";

export function createRootExecutionFreshness(params: {
  requestSteering: ReturnType<typeof resolveRequestSteeringInbox>;
  steeringVersion: number;
}): WorkerCapabilityExecutionFreshness {
  const snapshot = projectRequestSteeringSnapshot(
    params.requestSteering,
    params.steeringVersion,
  );
  return Object.freeze({
    token: Object.freeze({
      kind: "request_steering_v1" as const,
      version: snapshot.version,
      updates: Object.freeze(
        snapshot.updates.map(({ sequence, text }) =>
          Object.freeze({ sequence, text }),
        ),
      ),
    }),
    isCurrent: () => params.requestSteering.isCurrent(snapshot.version),
  });
}

/** Rebind the persisted token itself after verifying the exact accepted steering prefix. */
export function restoreApprovalExecutionFreshness(
  token: WorkerCapabilityExecutionFreshness["token"] | undefined,
  requestSteering: Parameters<typeof resolveRequestSteeringInbox>[0],
): WorkerCapabilityExecutionFreshness | undefined {
  if (token === undefined) return undefined;
  const inbox = resolveRequestSteeringInbox(requestSteering);
  const current = createRootExecutionFreshness({
    requestSteering: inbox,
    steeringVersion: token.version,
  });
  if (!isDeepStrictEqual(current.token, token))
    throw new Error("request_approval_steering_mismatch");
  if (!current.isCurrent())
    throw new Error("request_approval_steering_superseded");
  return Object.freeze({ token, isCurrent: current.isCurrent });
}
