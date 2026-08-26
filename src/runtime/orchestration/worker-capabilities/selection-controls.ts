import {
  normalizeWorkerCapabilityControlsSchema,
  validateWorkerCapabilityControls,
  type WorkerCapabilityControlsValidation,
} from "./controls.js";
import type { WorkerCapabilityControlsSchema } from "./contracts.js";

export type WorkerCapabilitySelectionControlIdsNormalization =
  | Readonly<{ ok: true; value: readonly string[] }>
  | Readonly<{
      ok: false;
      issueCode: string;
      controlId?: string;
    }>;

export type WorkerCapabilityControlsPartition = Readonly<{
  fullSchema: WorkerCapabilityControlsSchema;
  selectionSchema: WorkerCapabilityControlsSchema;
  remainingSchema: WorkerCapabilityControlsSchema;
  selectionControlIds: readonly string[];
}>;

export type WorkerCapabilityControlsPartitionResult =
  | Readonly<{ ok: true; value: WorkerCapabilityControlsPartition }>
  | Readonly<{
      ok: false;
      issueCode: string;
      controlId?: string;
    }>;

export function normalizeWorkerCapabilitySelectionControlIds(
  schema: WorkerCapabilityControlsSchema,
  input: unknown,
): WorkerCapabilitySelectionControlIdsNormalization {
  const normalizedSchema = normalizeWorkerCapabilityControlsSchema(schema);
  if (!normalizedSchema.ok) {
    return failure(normalizedSchema.issueCode);
  }
  if (input === undefined) {
    return Object.freeze({ ok: true as const, value: Object.freeze([]) });
  }
  if (!Array.isArray(input)) {
    return failure("selection_control_ids_invalid");
  }

  const supplied = new Set<string>();
  for (const candidate of input) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      return failure("selection_control_ids_invalid");
    }
    if (supplied.has(candidate)) {
      return failure("selection_control_ids_duplicate", candidate);
    }
    if (!Object.hasOwn(normalizedSchema.value.properties, candidate)) {
      return failure("selection_control_unknown", candidate);
    }
    if (!normalizedSchema.value.required.includes(candidate)) {
      return failure("selection_control_not_required", candidate);
    }
    supplied.add(candidate);
  }

  const value = Object.freeze(
    Object.keys(normalizedSchema.value.properties).filter((controlId) =>
      supplied.has(controlId),
    ),
  );
  return Object.freeze({ ok: true as const, value });
}

export function partitionWorkerCapabilityControlsSchema(
  schema: WorkerCapabilityControlsSchema,
  selectionControlIds?: unknown,
): WorkerCapabilityControlsPartitionResult {
  const normalizedSchema = normalizeWorkerCapabilityControlsSchema(schema);
  if (!normalizedSchema.ok) {
    return failure(normalizedSchema.issueCode);
  }
  const normalizedSelectionControlIds =
    normalizeWorkerCapabilitySelectionControlIds(
      normalizedSchema.value,
      selectionControlIds,
    );
  if (!normalizedSelectionControlIds.ok) {
    return normalizedSelectionControlIds;
  }

  const selected = new Set(normalizedSelectionControlIds.value);
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      fullSchema: normalizedSchema.value,
      selectionSchema: projectSchema(normalizedSchema.value, (controlId) =>
        selected.has(controlId),
      ),
      remainingSchema: projectSchema(
        normalizedSchema.value,
        (controlId) => !selected.has(controlId),
      ),
      selectionControlIds: normalizedSelectionControlIds.value,
    }),
  });
}

export function validateWorkerCapabilitySelectionControls(
  partition: WorkerCapabilityControlsPartition,
  input: unknown,
): WorkerCapabilityControlsValidation {
  return validateWorkerCapabilityControls(partition.selectionSchema, input);
}

export function validateWorkerCapabilityRemainingControls(
  partition: WorkerCapabilityControlsPartition,
  input: unknown,
): WorkerCapabilityControlsValidation {
  return validateWorkerCapabilityControls(partition.remainingSchema, input);
}

export function mergeWorkerCapabilityControls(
  partition: WorkerCapabilityControlsPartition,
  input: Readonly<{
    selectionControls: unknown;
    remainingControls: unknown;
  }>,
): WorkerCapabilityControlsValidation {
  const selection = validateWorkerCapabilitySelectionControls(
    partition,
    input.selectionControls,
  );
  if (!selection.ok) return selection;
  const remaining = validateWorkerCapabilityRemainingControls(
    partition,
    input.remainingControls,
  );
  if (!remaining.ok) return remaining;
  return validateWorkerCapabilityControls(
    partition.fullSchema,
    Object.freeze({ ...selection.value, ...remaining.value }),
  );
}

/**
 * Materializes a complete invocation only when selection already owns every
 * declared control. Optional remaining controls still require refinement.
 */
export function materializeWorkerCapabilityControlsIfComplete(
  partition: WorkerCapabilityControlsPartition,
  selectionControls: unknown,
): WorkerCapabilityControlsValidation | undefined {
  if (Object.keys(partition.remainingSchema.properties).length > 0) {
    return undefined;
  }
  return mergeWorkerCapabilityControls(partition, {
    selectionControls,
    remainingControls: Object.freeze({}),
  });
}

function projectSchema(
  schema: WorkerCapabilityControlsSchema,
  include: (controlId: string) => boolean,
): WorkerCapabilityControlsSchema {
  const properties = Object.freeze(
    Object.fromEntries(
      Object.entries(schema.properties).filter(([controlId]) =>
        include(controlId),
      ),
    ),
  );
  return Object.freeze({
    type: "object" as const,
    additionalProperties: false as const,
    properties,
    required: Object.freeze(
      schema.required.filter((controlId) => include(controlId)),
    ),
  });
}

function failure(
  issueCode: string,
  controlId?: string,
): Readonly<{
  ok: false;
  issueCode: string;
  controlId?: string;
}> {
  return Object.freeze({
    ok: false as const,
    issueCode,
    ...(controlId ? { controlId } : {}),
  });
}
