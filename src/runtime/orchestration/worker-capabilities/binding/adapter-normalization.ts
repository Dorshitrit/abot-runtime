import { isToolCatalogGroupId } from "../../../../capabilities/tool-types.js";
import { isRoleCapabilityId } from "../../role-calls/index.js";
import {
  WORKER_CAPABILITY_CONTROL_COUNT_MAX,
  WORKER_CAPABILITY_CONTROL_ID_MAX_LENGTH,
  WORKER_CAPABILITY_SUMMARY_MAX_LENGTH,
  type WorkerCapabilityAdapter,
  type WorkerCapabilityDescriptor,
  type WorkerCapabilityEffect,
} from "../contracts.js";
import { normalizeWorkerCapabilityControlsSchema } from "../controls.js";
import { partitionWorkerCapabilityControlsSchema } from "../selection-controls.js";

type AdapterNormalization<TContext> =
  | Readonly<{ ok: true; value: WorkerCapabilityAdapter<TContext> }>
  | Readonly<{ ok: false; issueCode: string }>;

type DescriptorNormalization =
  | Readonly<{ ok: true; value: WorkerCapabilityDescriptor }>
  | Readonly<{ ok: false; issueCode: string }>;

type RuntimePathControlIdsNormalization =
  | Readonly<{ ok: true; value: readonly string[] }>
  | Readonly<{ ok: false; issueCode: string }>;

export function normalizeCapabilityAdapter<TContext>(
  adapter: WorkerCapabilityAdapter<TContext>,
): AdapterNormalization<TContext> {
  if (!isRecordObject(adapter)) {
    return { ok: false, issueCode: "adapter_invalid" };
  }
  const descriptor = normalizeCapabilityDescriptor(adapter.descriptor);
  if (!descriptor.ok) return descriptor;
  if (typeof adapter.execute !== "function") {
    return { ok: false, issueCode: "adapter_execute_missing" };
  }
  if (adapter.prepare !== undefined && typeof adapter.prepare !== "function") {
    return { ok: false, issueCode: "adapter_prepare_invalid" };
  }
  return {
    ok: true,
    value: Object.freeze({
      descriptor: descriptor.value,
      ...(adapter.prepare ? { prepare: adapter.prepare } : {}),
      execute: adapter.execute,
    }),
  };
}

function normalizeCapabilityDescriptor(
  descriptor: WorkerCapabilityDescriptor,
): DescriptorNormalization {
  if (!isRecordObject(descriptor)) {
    return { ok: false, issueCode: "descriptor_invalid" };
  }
  if (!isRoleCapabilityId(descriptor.capabilityId)) {
    return { ok: false, issueCode: "descriptor_capability_id_invalid" };
  }
  if (!hasValidDescriptorSummary(descriptor.summary)) {
    return { ok: false, issueCode: "descriptor_summary_invalid" };
  }
  if (!isWorkerCapabilityEffect(descriptor.effect)) {
    return { ok: false, issueCode: "descriptor_effect_invalid" };
  }

  const controls = normalizeWorkerCapabilityControlsSchema(descriptor.controls);
  if (!controls.ok) {
    return { ok: false, issueCode: `descriptor_${controls.issueCode}` };
  }
  const runtimePathControlIds = normalizeRuntimePathControlIds(
    controls.value,
    descriptor.runtimePathControlIds,
  );
  if (!runtimePathControlIds.ok) {
    return {
      ok: false,
      issueCode: `descriptor_${runtimePathControlIds.issueCode}`,
    };
  }
  const controlsPartition = partitionWorkerCapabilityControlsSchema(
    controls.value,
    descriptor.selectionControlIds,
  );
  if (!controlsPartition.ok) {
    return {
      ok: false,
      issueCode: `descriptor_${controlsPartition.issueCode}`,
    };
  }
  if (!hasValidControlsRefinement(descriptor.controlsRefinement)) {
    return { ok: false, issueCode: "descriptor_controls_refinement_invalid" };
  }
  if (
    !hasValidPayloadAuthoringRequirement(
      descriptor.requiresPayloadAuthoringObjective,
    )
  ) {
    return {
      ok: false,
      issueCode: "descriptor_payload_authoring_objective_invalid",
    };
  }

  const catalogGroups = descriptor.catalogGroups ?? ["other"];
  if (!hasValidCatalogGroups(catalogGroups)) {
    return { ok: false, issueCode: "descriptor_catalog_groups_invalid" };
  }
  return {
    ok: true,
    value: Object.freeze({
      capabilityId: descriptor.capabilityId,
      summary: descriptor.summary.trim(),
      effect: descriptor.effect,
      controls: controls.value,
      ...(runtimePathControlIds.value.length > 0
        ? { runtimePathControlIds: runtimePathControlIds.value }
        : {}),
      ...(controlsPartition.value.selectionControlIds.length > 0
        ? { selectionControlIds: controlsPartition.value.selectionControlIds }
        : {}),
      ...(descriptor.controlsRefinement
        ? { controlsRefinement: descriptor.controlsRefinement }
        : {}),
      ...(descriptor.requiresPayloadAuthoringObjective
        ? { requiresPayloadAuthoringObjective: true as const }
        : {}),
      catalogGroups: Object.freeze([...catalogGroups]),
    }),
  };
}

function normalizeRuntimePathControlIds(
  controls: WorkerCapabilityDescriptor["controls"],
  input: readonly string[] | undefined,
): RuntimePathControlIdsNormalization {
  if (input === undefined) {
    return { ok: true, value: Object.freeze([]) };
  }
  if (!hasValidRuntimePathControlIdCount(input)) {
    return { ok: false, issueCode: "runtime_path_control_ids_invalid" };
  }
  const seen = new Set<string>();
  for (const controlId of input) {
    if (!isValidRuntimePathControlId(controlId)) {
      return { ok: false, issueCode: "runtime_path_control_ids_invalid" };
    }
    if (seen.has(controlId)) {
      return { ok: false, issueCode: "runtime_path_control_ids_duplicate" };
    }
    if (!Object.hasOwn(controls.properties, controlId)) {
      return { ok: false, issueCode: "runtime_path_control_unknown" };
    }
    seen.add(controlId);
  }
  return { ok: true, value: Object.freeze([...input]) };
}

function isRecordObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function hasValidDescriptorSummary(summary: unknown): summary is string {
  if (typeof summary !== "string") return false;
  if (summary.trim().length === 0) return false;
  return summary.length <= WORKER_CAPABILITY_SUMMARY_MAX_LENGTH;
}

function hasValidControlsRefinement(input: unknown): boolean {
  return input === undefined || input === "mechanical_when_complete";
}

function hasValidPayloadAuthoringRequirement(input: unknown): boolean {
  return input === undefined || input === true;
}

function hasValidCatalogGroups(input: readonly unknown[]): boolean {
  if (!Array.isArray(input)) return false;
  if (input.length === 0) return false;
  if (new Set(input).size !== input.length) return false;
  return input.every((catalogGroup) => isToolCatalogGroupId(catalogGroup));
}

function hasValidRuntimePathControlIdCount(input: unknown): input is string[] {
  if (!Array.isArray(input)) return false;
  if (input.length === 0) return false;
  return input.length <= WORKER_CAPABILITY_CONTROL_COUNT_MAX;
}

function isValidRuntimePathControlId(controlId: unknown): controlId is string {
  if (typeof controlId !== "string") return false;
  if (controlId.length === 0) return false;
  if (controlId.length > WORKER_CAPABILITY_CONTROL_ID_MAX_LENGTH) return false;
  return controlId.trim() === controlId;
}

function isWorkerCapabilityEffect(
  input: unknown,
): input is WorkerCapabilityEffect {
  return input === "observation" || input === "mutation" || input === "mixed";
}
