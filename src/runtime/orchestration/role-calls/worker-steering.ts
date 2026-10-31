import { SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT } from "./contracts.js";
import type {
  RoleCallFrame,
  RoleCallPolicy,
  RoleCallResult,
} from "./contracts.js";

export type RoleCallResultOutcome = "completed" | "failed" | "yielded";

export function isWorkerSteeringVersion(value: unknown): value is number {
  if (typeof value !== "number") return false;
  return Number.isSafeInteger(value) && value >= 0;
}

export function hasSupervisorWorkerSteeringAuthority(
  policy: RoleCallPolicy,
): boolean {
  const expected = SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT;
  if (policy.authority.id !== expected.id) return false;
  if (policy.authority.version !== expected.version) return false;
  return policy.authority.definitionHash === expected.definitionHash;
}

export function isValidWorkerSteeringBinding(
  call: Pick<RoleCallFrame, "roleId" | "workerSteeringVersion">,
  policy: RoleCallPolicy,
): boolean {
  if (call.workerSteeringVersion === undefined) return true;
  if (call.roleId !== "worker") return false;
  if (!hasSupervisorWorkerSteeringAuthority(policy)) return false;
  return isWorkerSteeringVersion(call.workerSteeringVersion);
}

export function isValidRoleResultSteeringVersion(
  result: Pick<RoleCallResult, "outcome" | "steeringVersion">,
  producer: Pick<RoleCallFrame, "roleId" | "workerSteeringVersion">,
  policy: RoleCallPolicy,
): boolean {
  if (!hasValidWorkResultSteeringIdentity(result, producer)) return false;
  if (result.outcome !== "yielded") return true;
  return hasSupervisorWorkerSteeringAuthority(policy);
}

export function hasValidWorkResultSteeringIdentity(
  result: Pick<RoleCallResult, "outcome" | "steeringVersion">,
  producer: Pick<RoleCallFrame, "roleId" | "workerSteeringVersion">,
): boolean {
  if (result.outcome === "yielded")
    return hasBoundWorkerYield(result, producer);
  if (result.steeringVersion !== undefined) return false;
  return result.outcome === "completed" || result.outcome === "failed";
}

function hasBoundWorkerYield(
  result: Pick<RoleCallResult, "steeringVersion">,
  producer: Pick<RoleCallFrame, "roleId" | "workerSteeringVersion">,
): boolean {
  if (producer.roleId !== "worker") return false;
  return isNewWorkerSteeringVersion(
    result.steeringVersion,
    producer.workerSteeringVersion,
  );
}

export function isNewWorkerSteeringVersion(
  value: unknown,
  boundVersion: number | undefined,
): value is number {
  if (!isWorkerSteeringVersion(value)) return false;
  return value > (boundVersion ?? 0);
}
