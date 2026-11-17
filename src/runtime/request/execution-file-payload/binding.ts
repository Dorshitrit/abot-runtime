import type { ExecutionPolicyAuthoritySnapshot } from "../../orchestration/role-calls/index.js";
import type { WorkerCapabilityPayloadAuthor } from "../../orchestration/worker-capabilities/payload-contracts.js";
import { isWorkerCapabilityPayloadAssignmentValid } from "../../orchestration/worker-capabilities/payload-assignment-validation.js";

export type FilePayloadInput = Parameters<WorkerCapabilityPayloadAuthor["author"]>[0];

/** A plugin's source hook cannot confer EA authority on another caller. */
export function isFilePayloadAssignmentValid(
  input: FilePayloadInput,
  requestId: string,
  authority?: ExecutionPolicyAuthoritySnapshot,
): boolean {
  if (authority?.id !== "execution-agent-v1") return false;
  if (authority.rootContractId !== "execution_agent") return false;
  if (!authority.capabilityAuthorities.includes("root")) return false;
  if (!isActiveExecutionRoot(input.call)) return false;
  if (!isWorkerCapabilityPayloadAssignmentValid(input, "root", requestId)) return false;
  return hasBoundRequestSteering(input.requestSteering);
}

function isActiveExecutionRoot(call: FilePayloadInput["call"]): boolean {
  if (call.roleId !== "supervisor") return false;
  if (call.parentCallId !== null || call.depth !== 0) return false;
  if (call.objective !== null || call.resultRef !== null) return false;
  if (call.status !== "active" || call.callId.length === 0) return false;
  return Number.isSafeInteger(call.activationCount) && call.activationCount > 0;
}

function hasBoundRequestSteering(steering: FilePayloadInput["requestSteering"]): boolean {
  if (steering?.kind !== "request_steering_v1") return false;
  if (!Number.isSafeInteger(steering.version) || steering.version < 0) return false;
  if (steering.updates.length !== steering.version) return false;
  return steering.updates.every((update, index) =>
    update.sequence === index + 1 && typeof update.text === "string" && update.text.trim().length > 0);
}
