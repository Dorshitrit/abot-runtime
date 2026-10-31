import type { RoleCallFrame } from "../orchestration/role-calls/index.js";
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
  if (token.kind === "worker_steering_v1") {
    if (
      !Number.isSafeInteger(token.version) || token.version < 0 ||
      token.version > inbox.snapshot().version
    )
      throw new Error("request_approval_steering_mismatch");
    if (!hasLiveSteeringInbox(inbox))
      throw new Error("request_approval_steering_superseded");
    return bindWorkerExecutionFreshness(inbox, token);
  }
  const current = createRootExecutionFreshness({
    requestSteering: inbox,
    steeringVersion: token.version,
  });
  if (!isDeepStrictEqual(current.token, token))
    throw new Error("request_approval_steering_mismatch");
  // A newer accepted prefix invalidates execution, not the saved approval.
  // A closed inbox has no current version and must remain terminal.
  if (!hasLiveSteeringInbox(inbox))
    throw new Error("request_approval_steering_superseded");
  return Object.freeze({ token, isCurrent: current.isCurrent });
}

function hasLiveSteeringInbox(
  inbox: ReturnType<typeof resolveRequestSteeringInbox>,
): boolean {
  return inbox.isCurrent(inbox.snapshot().version);
}

export function createWorkerExecutionFreshness(params: {
  requestSteering: ReturnType<typeof resolveRequestSteeringInbox>;
  call: RoleCallFrame;
}): WorkerCapabilityExecutionFreshness {
  return bindWorkerExecutionFreshness(
    params.requestSteering,
    Object.freeze({
      kind: "worker_steering_v1",
      callId: params.call.callId,
      version: params.call.workerSteeringVersion ?? 0,
    }),
  );
}

function bindWorkerExecutionFreshness(
  inbox: ReturnType<typeof resolveRequestSteeringInbox>,
  token: Extract<
    WorkerCapabilityExecutionFreshness["token"], { kind: "worker_steering_v1" }
  >,
): WorkerCapabilityExecutionFreshness {
  return Object.freeze({
    token,
    isCurrent: () => inbox.isCurrent(token.version),
    subscribe(listener: () => void) {
      const notify = () => {
        if (!inbox.isCurrent(token.version)) listener();
      };
      const unsubscribe = inbox.subscribe?.(notify) ?? (() => {});
      notify();
      return unsubscribe;
    },
  });
}
