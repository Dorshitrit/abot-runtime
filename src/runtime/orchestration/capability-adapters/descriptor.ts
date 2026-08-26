import { isRoleCapabilityId } from "../role-calls/index.js";
import {
  WORKER_CAPABILITY_SUMMARY_MAX_LENGTH,
  type WorkerCapabilityDescriptor,
} from "../worker-capabilities/contracts.js";
import { normalizeWorkerCapabilityControlsSchema } from "../worker-capabilities/controls.js";
import { partitionWorkerCapabilityControlsSchema } from "../worker-capabilities/selection-controls.js";
import { projectWorkerCapabilityScope } from "../worker-capabilities/scope.js";

export type CapabilityDescriptorNormalization =
  | Readonly<{ ok: true; value: WorkerCapabilityDescriptor }>
  | Readonly<{ ok: false; issueCode: string }>;

/**
 * Contract projection only. Adapter construction and execution remain owned by
 * the shared role-call capability binding.
 */
export function normalizeCapabilityDescriptor(
  descriptor: WorkerCapabilityDescriptor,
): CapabilityDescriptorNormalization {
  if (
    typeof descriptor !== "object" ||
    descriptor === null ||
    Array.isArray(descriptor) ||
    !isRoleCapabilityId(descriptor.capabilityId)
  ) {
    return failure("descriptor_invalid");
  }
  if (
    typeof descriptor.summary !== "string" ||
    descriptor.summary.trim().length === 0 ||
    descriptor.summary.length > WORKER_CAPABILITY_SUMMARY_MAX_LENGTH
  ) {
    return failure("descriptor_summary_invalid");
  }
  const controls = normalizeWorkerCapabilityControlsSchema(descriptor.controls);
  if (!controls.ok) return failure(`descriptor_${controls.issueCode}`);
  const partition = partitionWorkerCapabilityControlsSchema(
    controls.value,
    descriptor.selectionControlIds,
  );
  if (!partition.ok) return failure(`descriptor_${partition.issueCode}`);
  try {
    projectWorkerCapabilityScope({
      entries: [descriptor],
      descriptorOf: (entry) => entry,
    });
  } catch {
    return failure("descriptor_scope_invalid");
  }
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      ...descriptor,
      summary: descriptor.summary.trim(),
      controls: controls.value,
      ...(partition.value.selectionControlIds.length > 0
        ? { selectionControlIds: partition.value.selectionControlIds }
        : {}),
      catalogGroups: Object.freeze([
        ...(descriptor.catalogGroups ?? ["other"]),
      ]),
    }),
  });
}

function failure(issueCode: string): Readonly<{
  ok: false;
  issueCode: string;
}> {
  return Object.freeze({ ok: false as const, issueCode });
}
