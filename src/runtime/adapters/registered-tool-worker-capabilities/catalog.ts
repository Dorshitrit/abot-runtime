import type {
  RegisteredToolNormalInvocation,
  ToolExecutionRequestContext,
  ToolExecutionSharedState,
  ToolNormalInvocationOperation,
} from "../../../capabilities/tool-types.js";
import {
  WORKER_CAPABILITY_COUNT_MAX,
  normalizeWorkerCapabilityControlsSchema,
  partitionWorkerCapabilityControlsSchema,
  type WorkerCapabilityDescriptor,
} from "../../orchestration/worker-capabilities/index.js";
import { isRoleCapabilityId } from "../../orchestration/role-calls/index.js";
import type { ToolRegistry } from "../../ports.js";
import { projectRuntimePathBindings } from "../registered-tool-normal-invocations.js";
import {
  deriveRegisteredToolStagedPayloadPlan,
  type RegisteredToolStagedPayloadPlan,
} from "../registered-tool-payload-plan.js";
import type {
  ResolvedCapabilityCatalog,
  SelectedOperation,
} from "./contracts.js";
import { RegisteredToolWorkerCapabilityCompositionError } from "./errors.js";

export function resolveRegisteredToolCapabilityCatalog(
  registry: ToolRegistry,
  payloadAuthorAvailable: boolean,
): ResolvedCapabilityCatalog {
  const registrations = captureRegistrySnapshot(registry);
  const selected = resolveAvailableOperations(
    registrations,
    payloadAuthorAvailable,
  );
  const operationIds = Object.freeze(
    selected.map(({ operation }) => operation.operationId),
  );
  const descriptors = Object.freeze(
    selected.map(({ registration, operation, stagedPayloadPlan }) =>
      projectWorkerDescriptor(
        registration.definition,
        operation,
        stagedPayloadPlan,
      ),
    ),
  );
  return Object.freeze({
    registry,
    selected,
    operationIds,
    descriptors,
  });
}

function captureRegistrySnapshot(
  registry: ToolRegistry,
): readonly RegisteredToolNormalInvocation[] {
  if (
    typeof registry !== "object" ||
    registry === null ||
    typeof registry.listNormalInvocations !== "function"
  ) {
    throw new RegisteredToolWorkerCapabilityCompositionError(
      "normal_invocation_registry_unavailable",
    );
  }
  const registrations = Reflect.apply(
    registry.listNormalInvocations,
    registry,
    [],
  ) as unknown;
  if (!Array.isArray(registrations)) {
    throw new RegisteredToolWorkerCapabilityCompositionError(
      "normal_invocation_registry_invalid",
    );
  }
  return Object.freeze([...registrations]);
}

function resolveAvailableOperations(
  registrations: readonly RegisteredToolNormalInvocation[],
  payloadAuthorAvailable: boolean,
): readonly SelectedOperation[] {
  const selected = registrations.flatMap((registration) =>
    registration.contract.operations.map((operation) => {
      const stagedPayloadPlan = deriveRegisteredToolStagedPayloadPlan(
        registration.definition,
        operation,
      );
      return Object.freeze({
        registration,
        operation,
        ...(stagedPayloadPlan ? { stagedPayloadPlan } : {}),
      });
    }),
  );
  if (selected.length > WORKER_CAPABILITY_COUNT_MAX) {
    throw new RegisteredToolWorkerCapabilityCompositionError(
      "operation_count_exceeded",
    );
  }
  const seen = new Set<string>();
  for (const entry of selected) {
    const operationId = entry.operation.operationId;
    if (seen.has(operationId)) {
      throw new RegisteredToolWorkerCapabilityCompositionError(
        "operation_ambiguous",
        operationId,
      );
    }
    seen.add(operationId);
    validateWorkerOperation(
      entry.operation,
      entry.stagedPayloadPlan,
      payloadAuthorAvailable,
    );
  }
  return Object.freeze(selected);
}

function validateWorkerOperation(
  operation: ToolNormalInvocationOperation,
  stagedPayloadPlan: RegisteredToolStagedPayloadPlan | undefined,
  payloadAuthorAvailable: boolean,
) {
  if (!isRoleCapabilityId(operation.operationId)) {
    throw new RegisteredToolWorkerCapabilityCompositionError(
      "capability_id_unsupported",
      operation.operationId,
    );
  }
  if (
    operation.effect !== "read_only" &&
    operation.effect !== "mutating" &&
    operation.effect !== "mixed"
  ) {
    throw new RegisteredToolWorkerCapabilityCompositionError(
      "operation_effect_unsupported",
      operation.operationId,
    );
  }
  if (
    !normalizeWorkerCapabilityControlsSchema(
      stagedPayloadPlan?.publicInput ?? operation.input,
    ).ok
  ) {
    throw new RegisteredToolWorkerCapabilityCompositionError(
      "operation_controls_unsupported",
      operation.operationId,
    );
  }
  if (operation.payload && !payloadAuthorAvailable) {
    throw new RegisteredToolWorkerCapabilityCompositionError(
      "operation_payload_author_unavailable",
      operation.operationId,
    );
  }
}

function projectWorkerDescriptor(
  definition: RegisteredToolNormalInvocation["definition"],
  operation: ToolNormalInvocationOperation,
  stagedPayloadPlan: RegisteredToolStagedPayloadPlan | undefined,
): WorkerCapabilityDescriptor {
  const controls = normalizeWorkerCapabilityControlsSchema(
    stagedPayloadPlan?.publicInput ?? operation.input,
  );
  if (!controls.ok) {
    throw new RegisteredToolWorkerCapabilityCompositionError(
      "operation_controls_unsupported",
      operation.operationId,
    );
  }
  const payloadTargetControlId =
    definition.payloadChannelSpec?.targetRole === "operation_target"
      ? definition.payloadChannelSpec.targetParam
      : undefined;
  const selectionControlIds =
    definition.payloadChannelSpec?.targetRole === "operation_target" &&
    !payloadTargetControlId
      ? undefined
      : Object.freeze([
          ...new Set([
            ...(operation.selectionControlIds ?? []),
            ...(payloadTargetControlId ? [payloadTargetControlId] : []),
          ]),
        ]);
  const controlsPartition = partitionWorkerCapabilityControlsSchema(
    controls.value,
    selectionControlIds,
  );
  if (!controlsPartition.ok || selectionControlIds === undefined) {
    throw new RegisteredToolWorkerCapabilityCompositionError(
      "operation_target_control_invalid",
      operation.operationId,
    );
  }
  const runtimePathControlIds = projectRuntimePathControlIds(
    definition,
    operation,
    controls.value,
  );
  const effect =
    operation.effect === "mutating"
      ? ("mutation" as const)
      : operation.effect === "mixed"
        ? ("mixed" as const)
        : ("observation" as const);
  const catalogGroups = Object.freeze([
    ...(definition.catalogGroups ?? ["other"]),
  ]);
  return Object.freeze({
    capabilityId: operation.operationId,
    summary: operation.summary,
    effect,
    controls: controls.value,
    ...(runtimePathControlIds.length > 0 ? { runtimePathControlIds } : {}),
    ...(controlsPartition.value.selectionControlIds.length > 0
      ? { selectionControlIds: controlsPartition.value.selectionControlIds }
      : {}),
    ...(definition.controlsRefinement
      ? { controlsRefinement: definition.controlsRefinement }
      : {}),
    ...(operation.payload
      ? { requiresPayloadAuthoringObjective: true as const }
      : {}),
    catalogGroups,
  });
}

function projectRuntimePathControlIds(
  definition: RegisteredToolNormalInvocation["definition"],
  operation: ToolNormalInvocationOperation,
  controls: WorkerCapabilityDescriptor["controls"],
): readonly string[] {
  const controlIds = projectRuntimePathBindings(definition, operation).map(
    ({ param }) => param,
  );
  if (controlIds.length === 0) {
    return Object.freeze([]);
  }
  if (
    new Set(controlIds).size !== controlIds.length ||
    controlIds.some(
      (controlId) =>
        typeof controlId !== "string" ||
        !Object.hasOwn(controls.properties, controlId),
    )
  ) {
    throw new RegisteredToolWorkerCapabilityCompositionError(
      "operation_runtime_path_control_invalid",
      operation.operationId,
    );
  }
  return Object.freeze([...controlIds]);
}

export function narrowRegistrations(
  selections: readonly SelectedOperation[],
): readonly RegisteredToolNormalInvocation[] {
  const selectedByRegistration = new Map<
    RegisteredToolNormalInvocation,
    ToolNormalInvocationOperation[]
  >();
  for (const selection of selections) {
    const operations = selectedByRegistration.get(selection.registration) ?? [];
    operations.push(selection.operation);
    selectedByRegistration.set(selection.registration, operations);
  }
  return Object.freeze(
    [...selectedByRegistration].map(([registration, operations]) =>
      Object.freeze({
        toolName: registration.toolName,
        definition: registration.definition,
        contract: Object.freeze({
          version: registration.contract.version,
          operations: Object.freeze([...operations]),
        }),
        ...(registration.adapter ? { adapter: registration.adapter } : {}),
      }),
    ),
  );
}

export function prepareSharedState(
  registry: ToolRegistry,
  sessionId: string,
  requestContext?: ToolExecutionRequestContext,
): ToolExecutionSharedState {
  const initial: ToolExecutionSharedState = Object.freeze({
    currentSessionId: sessionId,
    ...(requestContext ? { requestContext } : {}),
  });
  return registry.prepareSharedState
    ? registry.prepareSharedState(initial)
    : initial;
}
