import {
  isRoleCapabilityId,
  ROLE_CAPABILITY_EXECUTION_LIMIT_MAX,
} from "../../orchestration/role-calls/index.js";
import { WORKER_CAPABILITY_COUNT_MAX } from "../../orchestration/worker-capabilities/index.js";

export type WorkerCapabilitySelectionRejection = Readonly<{
  rejectedSelectionKind: "single" | "batch";
  rejectedCapabilityIds: readonly string[];
  rejectedInvocationCount: number;
}>;

export function createWorkerCapabilitySelectionRejection(input: {
  rejectedSelectionKind: "single" | "batch";
  rejectedCapabilityIds: readonly string[];
  rejectedInvocationCount: number;
  reason: string;
}): Readonly<{
  rejection: WorkerCapabilitySelectionRejection;
  reasonLength: number;
}> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new Error("worker_capability_selection_rejection_reason_invalid");
  }
  return Object.freeze({
    rejection: normalizeWorkerCapabilitySelectionRejection(
      input,
      input.rejectedCapabilityIds,
    ),
    reasonLength: reason.length,
  });
}

export function normalizeWorkerCapabilitySelectionRejection(
  input: WorkerCapabilitySelectionRejection,
  availableCapabilityIds: readonly string[],
): WorkerCapabilitySelectionRejection {
  const rejectedCapabilityIds = Array.isArray(input?.rejectedCapabilityIds)
    ? input.rejectedCapabilityIds
    : [];
  const uniqueCapabilityIds = new Set(rejectedCapabilityIds);
  if (
    typeof input !== "object" ||
    input === null ||
    (input.rejectedSelectionKind !== "single" &&
      input.rejectedSelectionKind !== "batch") ||
    rejectedCapabilityIds.length === 0 ||
    rejectedCapabilityIds.length > WORKER_CAPABILITY_COUNT_MAX ||
    uniqueCapabilityIds.size !== rejectedCapabilityIds.length ||
    rejectedCapabilityIds.some(
      (capabilityId) =>
        !isRoleCapabilityId(capabilityId) ||
        !availableCapabilityIds.includes(capabilityId),
    ) ||
    !Number.isInteger(input.rejectedInvocationCount) ||
    input.rejectedInvocationCount > ROLE_CAPABILITY_EXECUTION_LIMIT_MAX ||
    (input.rejectedSelectionKind === "single"
      ? input.rejectedInvocationCount !== 1 ||
        rejectedCapabilityIds.length !== 1
      : input.rejectedInvocationCount < 2 ||
        input.rejectedInvocationCount < rejectedCapabilityIds.length)
  ) {
    throw new Error("worker_capability_selection_rejection_invalid");
  }
  return Object.freeze({
    rejectedSelectionKind: input.rejectedSelectionKind,
    rejectedCapabilityIds: Object.freeze([...rejectedCapabilityIds]),
    rejectedInvocationCount: input.rejectedInvocationCount,
  });
}
