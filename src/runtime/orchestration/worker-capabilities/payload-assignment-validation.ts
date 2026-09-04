import { WORKER_CAPABILITY_AUTHORING_OBJECTIVE_MAX_LENGTH } from "./contracts.js";
import { isWorkerCapabilityPayloadSourceProvenanceValid } from "./payload-source-provenance.js";
import type { WorkerCapabilityPayloadAuthor } from "./payload-contracts.js";

/** Validates payload assignment ownership before any model boundary is built. */
export function isWorkerCapabilityPayloadAssignmentValid(
  input: Parameters<WorkerCapabilityPayloadAuthor["author"]>[0],
  principalKind: "worker" | "root",
  requestId: string,
): boolean {
  if (principalKind === "root") {
    return (
      input.assignmentProvenance === undefined &&
      !Object.hasOwn(input, "authoringObjective") &&
      hasExecutionId(input.executionId)
    );
  }
  if (!hasExecutionId(input.executionId)) return false;
  if (
    !isWorkerCapabilityPayloadSourceProvenanceValid(
      input.assignmentProvenance,
      input.call,
      requestId,
    )
  ) {
    return false;
  }
  if (input.descriptor.requiresPayloadAuthoringObjective !== true) return false;
  if (!Object.hasOwn(input, "authoringObjective")) return false;
  return isValidAuthoringObjective(input.authoringObjective);
}

function hasExecutionId(executionId: string): boolean {
  return typeof executionId === "string" && executionId.length > 0;
}

function isValidAuthoringObjective(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.trim() !== value || value.length === 0) return false;
  return value.length <= WORKER_CAPABILITY_AUTHORING_OBJECTIVE_MAX_LENGTH;
}
