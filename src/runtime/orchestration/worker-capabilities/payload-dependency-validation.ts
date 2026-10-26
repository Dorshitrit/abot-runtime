import {
  isRoleCallResultText,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  type RoleCallFrame,
} from "../role-calls/index.js";
import { isRuntimeDelegateRoleId } from "../roles.js";
import type { WorkerCapabilityPayloadAuthor } from "./payload-contracts.js";

type PayloadAuthorInput = Parameters<WorkerCapabilityPayloadAuthor["author"]>[0];

export function isWorkerPayloadDependencyContextValid(
  results: PayloadAuthorInput["dependencyResults"],
  call: RoleCallFrame,
): boolean {
  const projected = results ?? [];
  if (
    !Array.isArray(projected) ||
    projected.length !== call.dependencyResultRefs.length
  ) {
    return false;
  }
  return projected.every((candidate, index) => {
    if (!isObjectRecord(candidate)) return false;
    const keys = Object.keys(candidate);
    const semanticCheckpoints = candidate.semanticCheckpoints;
    const producerObjective = candidate.producerObjective;
    return (
      keys.length >= 5 &&
      keys.length <= 7 &&
      keys.every(
        (key) =>
          key === "resultRef" ||
          key === "producerCallId" ||
          key === "producerObjective" ||
          key === "roleId" ||
          key === "outcome" ||
          key === "summary" ||
          key === "semanticCheckpoints",
      ) &&
      candidate.resultRef === call.dependencyResultRefs[index] &&
      typeof candidate.producerCallId === "string" &&
      candidate.producerCallId.length > 0 &&
      isOptionalProducerObjectiveValid(producerObjective) &&
      isRuntimeDelegateRoleId(candidate.roleId) &&
      (candidate.outcome === "completed" || candidate.outcome === "failed") &&
      isRoleCallResultText(candidate.summary) &&
      (semanticCheckpoints === undefined ||
        (Array.isArray(semanticCheckpoints) &&
          semanticCheckpoints.length > 0 &&
          semanticCheckpoints.every(
            (checkpoint) =>
              isObjectRecord(checkpoint) &&
              checkpoint.kind === "runtime_semantic_compaction_checkpoint_v2",
          )))
    );
  });
}

function isOptionalProducerObjectiveValid(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  if (value.trim().length === 0) return false;
  return value.length <= ROLE_CALL_OBJECTIVE_MAX_LENGTH;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
