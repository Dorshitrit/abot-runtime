import {
  isToolCatalogGroupId,
  type ToolCatalogGroup,
} from "../../../../capabilities/tool-types.js";
import {
  isRoleCapabilityId,
  projectRoleCallAssignmentScope,
  projectImmediateRoleOperationSupervisionNotices,
  type RoleCallFrame,
  type RoleCallDependencyResult,
  type RoleCallLedger,
} from "../../../orchestration/role-calls/index.js";
import {
  WORKER_CAPABILITY_COUNT_MAX,
  WORKER_CAPABILITY_SUMMARY_MAX_LENGTH,
  normalizeWorkerCapabilityControlsSchema,
  partitionWorkerCapabilityControlsSchema,
  type WorkerCapabilityDescriptor,
} from "../../../orchestration/worker-capabilities/index.js";
import { projectSemanticCompactionDependencyResults } from "../../../context/semantic-compaction/index.js";
import type { RequestExecutionSeed } from "../../../request/contracts.js";
import { projectWorkerCapabilityResumeContext } from "../ledger-projection.js";
import {
  projectWorkerDecisionCallIdentity,
  type WorkerDecisionDiagnosticContext,
} from "../contracts.js";
import { projectEffectiveWorkerSelectionControlIds } from "../runtime-path-refinement.js";
import type {
  PreparedWorkerCanonicalState,
  WorkerDecisionCapabilityBinding,
  WorkerDecisionCapabilityResumeSource,
  WorkerDecisionCapabilitySource,
  WorkerDecisionInputOptions,
} from "./types.js";

export function prepareWorkerCanonicalState(
  request: Pick<RequestExecutionSeed, "requestId" | "prompt"> &
    Partial<Pick<RequestExecutionSeed, "contextCompactionStore">>,
  options: WorkerDecisionInputOptions,
  callIdentity: ReturnType<typeof projectWorkerDecisionCallIdentity>,
  modelStep: WorkerDecisionDiagnosticContext["modelStep"],
  capabilityExecutionPending: boolean,
): PreparedWorkerCanonicalState {
  const canonicalSource = options.capabilitySource ?? options.capabilityResume;
  const assignmentScope = canonicalSource
    ? projectRoleCallAssignmentScope({
        head: canonicalSource.head,
        call: options.call,
        modelStep,
      })
    : undefined;
  const dependencyResults = canonicalSource
    ? projectSemanticCompactionDependencyResults({
        requestId: request.requestId,
        prompt: request.prompt,
        head: canonicalSource.head,
        call: options.call,
        consumer: modelStep,
        ...(request.contextCompactionStore
          ? { store: request.contextCompactionStore }
          : {}),
      })
    : requireNoUnresolvedDependencies(options.call);
  const resume = options.capabilityResume
    ? projectWorkerCapabilityResumeContext(
        options.capabilityResume.ledger,
        options.capabilityResume.head,
        {
          callId: callIdentity.callId,
          ...(hasBatchCapabilityResume(options.capabilityResume)
            ? { executionIds: options.capabilityResume.executionIds }
            : { executionId: options.capabilityResume.executionId }),
        },
      )
    : undefined;

  if (resume !== undefined && resume.requestId !== request.requestId) {
    throw new Error("worker_capability_resume_request_mismatch");
  }
  const operationSupervision = shouldProjectWorkerOperationSupervision(
    canonicalSource,
    capabilityExecutionPending,
  )
    ? projectImmediateRoleOperationSupervisionNotices(
        canonicalSource.head,
        options.call,
      )
    : Object.freeze([]);
  return Object.freeze({
    canonicalSource,
    assignmentScope,
    dependencyResults,
    resume,
    operationSupervision:
      operationSupervision.length > 0 ? operationSupervision : undefined,
  });
}

function shouldProjectWorkerOperationSupervision(
  canonicalSource:
    | WorkerDecisionCapabilitySource
    | WorkerDecisionCapabilityResumeSource
    | undefined,
  capabilityExecutionPending: boolean,
): canonicalSource is
  | WorkerDecisionCapabilitySource
  | WorkerDecisionCapabilityResumeSource {
  return canonicalSource !== undefined && !capabilityExecutionPending;
}

function hasBatchCapabilityResume(
  source: WorkerDecisionCapabilityResumeSource,
): source is WorkerDecisionCapabilityResumeSource &
  Readonly<{ executionIds: readonly string[] }> {
  return "executionIds" in source;
}

function requireNoUnresolvedDependencies(
  call: RoleCallFrame,
): readonly RoleCallDependencyResult[] {
  if (call.dependencyResultRefs.length > 0) {
    throw new Error("worker_dependency_source_missing");
  }
  return Object.freeze([]);
}

export function projectCapabilities(
  params: Readonly<{
    requestId: string;
    call: RoleCallFrame;
    binding?: WorkerDecisionCapabilityBinding;
    authorityLedger?: RoleCallLedger;
    deferRuntimePathControls: boolean;
  }>,
): readonly WorkerCapabilityDescriptor[] {
  const {
    requestId,
    call,
    binding,
    authorityLedger,
    deferRuntimePathControls,
  } = params;
  if (binding === undefined) return Object.freeze([]);
  if (
    !Object.isFrozen(binding) ||
    binding.ledger !== authorityLedger ||
    binding.requestId !== requestId ||
    binding.callId !== call.callId ||
    binding.invocationAttempt !== call.activationCount ||
    !Array.isArray(binding.capabilities) ||
    !Object.isFrozen(binding.capabilities) ||
    binding.capabilities.length > WORKER_CAPABILITY_COUNT_MAX
  ) {
    throw new Error("worker_capability_binding_projection_invalid");
  }
  const seen = new Set<string>();
  const capabilities = binding.capabilities.map((descriptor) => {
    const descriptorKeys =
      typeof descriptor === "object" && descriptor !== null
        ? Object.keys(descriptor)
        : [];
    if (
      typeof descriptor !== "object" ||
      descriptor === null ||
      !Object.isFrozen(descriptor) ||
      descriptorKeys.length < 5 ||
      descriptorKeys.length > 9 ||
      descriptorKeys.some(
        (key) =>
          key !== "capabilityId" &&
          key !== "summary" &&
          key !== "effect" &&
          key !== "controls" &&
          key !== "selectionControlIds" &&
          key !== "runtimePathControlIds" &&
          key !== "controlsRefinement" &&
          key !== "catalogGroups" &&
          key !== "requiresPayloadAuthoringObjective",
      ) ||
      !isRoleCapabilityId(descriptor.capabilityId) ||
      seen.has(descriptor.capabilityId) ||
      typeof descriptor.summary !== "string" ||
      descriptor.summary.trim().length === 0 ||
      descriptor.summary.length > WORKER_CAPABILITY_SUMMARY_MAX_LENGTH ||
      (descriptor.effect !== "observation" &&
        descriptor.effect !== "mutation" &&
        descriptor.effect !== "mixed") ||
      (descriptor.controlsRefinement !== undefined &&
        descriptor.controlsRefinement !== "mechanical_when_complete") ||
      (descriptor.requiresPayloadAuthoringObjective !== undefined &&
        descriptor.requiresPayloadAuthoringObjective !== true) ||
      !Array.isArray(descriptor.catalogGroups) ||
      descriptor.catalogGroups.length === 0 ||
      descriptor.catalogGroups.some(
        (groupId: ToolCatalogGroup) => !isToolCatalogGroupId(groupId),
      ) ||
      new Set(descriptor.catalogGroups).size !== descriptor.catalogGroups.length
    ) {
      throw new Error("worker_capability_binding_projection_invalid");
    }
    const controls = normalizeWorkerCapabilityControlsSchema(
      descriptor.controls,
    );
    if (!controls.ok) {
      throw new Error("worker_capability_binding_projection_invalid");
    }
    const controlsPartition = partitionWorkerCapabilityControlsSchema(
      controls.value,
      descriptor.selectionControlIds,
    );
    if (!controlsPartition.ok) {
      throw new Error("worker_capability_binding_projection_invalid");
    }
    const runtimePathControlIds = descriptor.runtimePathControlIds ?? [];
    if (
      !Array.isArray(runtimePathControlIds) ||
      new Set(runtimePathControlIds).size !== runtimePathControlIds.length ||
      runtimePathControlIds.some(
        (controlId) =>
          typeof controlId !== "string" ||
          !Object.hasOwn(controls.value.properties, controlId),
      )
    ) {
      throw new Error("worker_capability_binding_projection_invalid");
    }
    const effectiveSelectionControlIds =
      projectEffectiveWorkerSelectionControlIds(
        {
          selectionControlIds: controlsPartition.value.selectionControlIds,
          runtimePathControlIds,
        },
        deferRuntimePathControls,
      );
    seen.add(descriptor.capabilityId);
    return Object.freeze({
      capabilityId: descriptor.capabilityId,
      summary: descriptor.summary,
      effect: descriptor.effect,
      controls: controls.value,
      ...(effectiveSelectionControlIds.length > 0
        ? {
            selectionControlIds: effectiveSelectionControlIds,
          }
        : {}),
      ...(runtimePathControlIds.length > 0
        ? { runtimePathControlIds: Object.freeze([...runtimePathControlIds]) }
        : {}),
      ...(descriptor.controlsRefinement
        ? { controlsRefinement: descriptor.controlsRefinement }
        : {}),
      ...(descriptor.requiresPayloadAuthoringObjective
        ? { requiresPayloadAuthoringObjective: true as const }
        : {}),
      catalogGroups: Object.freeze([...descriptor.catalogGroups]),
    });
  });
  return Object.freeze(capabilities);
}

export function validateCanonicalSources(
  params: Readonly<{
    requestId: string;
    call: RoleCallFrame;
    capabilitySource?: WorkerDecisionCapabilitySource;
    resumeSource?: WorkerDecisionCapabilityResumeSource;
  }>,
): void {
  const { requestId, call, capabilitySource, resumeSource } = params;
  if (
    capabilitySource &&
    resumeSource &&
    (capabilitySource.ledger !== resumeSource.ledger ||
      capabilitySource.head !== resumeSource.head)
  ) {
    throw new Error("worker_capability_sources_mismatch");
  }
  const source = capabilitySource ?? resumeSource;
  if (!source) return;
  if (source.ledger.current() !== source.head) {
    throw new Error("worker_capability_source_head_stale");
  }
  const canonicalCall = source.head.state.calls.find(
    (candidate) => candidate.callId === source.head.state.activeCallId,
  );
  if (
    source.head.state.requestId !== requestId ||
    source.head.state.phase !== "running"
  ) {
    throw new Error("worker_capability_source_request_mismatch");
  }
  if (canonicalCall !== call) {
    throw new Error("worker_capability_source_call_mismatch");
  }
}
