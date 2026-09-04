import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../role-calls/contracts.js";
import { projectRoleCallDependencyResults } from "../role-calls/dependency-results.js";
import type { WorkerCapabilityAssignmentProvenance } from "./contracts.js";

type WorkerCapabilityAssignmentIdentity =
  | RoleCallFrame
  | Readonly<{
      callId: string;
      parentCallId: string | null;
      depth: number;
      objective: string;
      invocationAttempt: number;
    }>;

export type WorkerCapabilityDependencyArtifactReceipt = Readonly<{
  sourceExecutionId: string;
  targetPath: string;
}>;

const WORKER_ASSIGNMENT_AUTHORITY = Symbol("workerAssignmentAuthority");

type WorkerAssignmentAuthority = Readonly<{
  receipt: object;
  requestId: string;
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
}>;

const EMPTY_DEPENDENCY_ARTIFACT_RECEIPTS = Object.freeze(
  [] as readonly WorkerCapabilityDependencyArtifactReceipt[],
);

export type WorkerCapabilityPlannerItemBinding = Readonly<{
  plannerCallId: string;
  planId: string;
  itemId: string;
  workerCallId: string;
}>;

/** Resolves one direct Planner-item binding from the canonical ledger head. */
export function projectWorkerCapabilityPlannerItemBinding(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): WorkerCapabilityPlannerItemBinding | undefined {
  const canonicalCall = head.state.calls.find(
    ({ callId }) => callId === call.callId,
  );
  if (canonicalCall !== call) {
    throw new Error("worker_assignment_provenance_authority_invalid");
  }
  if (call.roleId !== "worker" || call.parentCallId === null) return undefined;

  const parent = head.state.calls.find(
    ({ callId }) => callId === call.parentCallId,
  );
  if (!parent || parent.depth !== call.depth - 1) {
    throw new Error("worker_assignment_provenance_parent_invalid");
  }
  if (parent.roleId !== "planner") return undefined;

  const plan = head.state.plans.find(
    ({ definition }) => definition.plannerCallId === parent.callId,
  );
  const boundItems = plan?.itemStates.filter(
    ({ childCallId }) => childCallId === call.callId,
  );
  if (!plan || !boundItems) {
    throw new Error("worker_assignment_provenance_plan_binding_invalid");
  }
  if (boundItems.length !== 1) {
    throw new Error("worker_assignment_provenance_plan_binding_invalid");
  }
  return Object.freeze({
    plannerCallId: parent.callId,
    planId: plan.definition.planId,
    itemId: boundItems[0]!.itemId,
    workerCallId: call.callId,
  });
}

/** Projects the canonical proof that one Worker owns one bound Planner item. */
export function projectWorkerCapabilityAssignmentProvenance(
  params: Readonly<{
    head: RoleCallLedgerHead;
    call: RoleCallFrame;
  }>,
): WorkerCapabilityAssignmentProvenance | undefined {
  const canonicalCall = params.head.state.calls.find(
    ({ callId }) => callId === params.call.callId,
  );
  if (canonicalCall !== params.call || canonicalCall.roleId !== "worker") {
    throw new Error("worker_assignment_provenance_authority_invalid");
  }
  const binding = projectWorkerCapabilityPlannerItemBinding(
    params.head,
    canonicalCall,
  );
  if (!binding) return undefined;
  assertPlannerItemIsActive(params.head, binding);
  const provenance = {
    kind: "planner_plan_item_v1" as const,
    requestId: params.head.state.requestId,
    sourceRevision: params.head.revision,
    ...binding,
    invocationAttempt: canonicalCall.activationCount,
  };
  const authority = Object.freeze({
    receipt: provenance,
    requestId: params.head.state.requestId,
    head: params.head,
    call: canonicalCall,
  });
  Object.defineProperty(provenance, WORKER_ASSIGNMENT_AUTHORITY, {
    value: authority,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(provenance) as WorkerCapabilityAssignmentProvenance;
}

/** Validates the canonical receipt against the exact consuming Worker call. */
export function isWorkerCapabilityAssignmentProvenanceValid(
  provenance: WorkerCapabilityAssignmentProvenance | undefined,
  identity: WorkerCapabilityAssignmentIdentity,
  requestId: string,
): boolean {
  if (provenance === undefined) return true;
  const authority = readWorkerAssignmentAuthority(provenance);
  if (!authority) return false;
  if (authority.requestId !== requestId) return false;
  if (!Object.isFrozen(provenance)) return false;
  if (provenance.kind !== "planner_plan_item_v1") return false;
  if (provenance.requestId !== requestId) return false;
  if (provenance.workerCallId !== identity.callId) return false;
  if (provenance.plannerCallId !== identity.parentCallId) return false;
  const invocationAttempt =
    "activationCount" in identity
      ? identity.activationCount
      : identity.invocationAttempt;
  if (provenance.invocationAttempt !== invocationAttempt) return false;
  if ("activationCount" in identity) {
    return identity.roleId === "worker" && authority.call === identity;
  }
  return (
    authority.call.depth === identity.depth &&
    authority.call.objective === identity.objective
  );
}

/** Resolves model-visible request scope only from a verified runtime receipt. */
export function projectWorkerRequestSourceProjection(
  provenance: WorkerCapabilityAssignmentProvenance | undefined,
  identity: WorkerCapabilityAssignmentIdentity,
  requestId: string,
): "full_request" | "assignment_only" {
  if (
    !isWorkerCapabilityAssignmentProvenanceValid(
      provenance,
      identity,
      requestId,
    )
  ) {
    throw new Error("worker_assignment_provenance_receipt_invalid");
  }
  return provenance ? "assignment_only" : "full_request";
}

/**
 * Resolves only successful artifact references produced by the exact direct
 * sibling results canonically attached to one Planner-bound Worker.
 */
export function projectWorkerCapabilityDependencyArtifactReceipts(
  provenance: WorkerCapabilityAssignmentProvenance | undefined,
  call: RoleCallFrame,
): readonly WorkerCapabilityDependencyArtifactReceipt[] {
  if (!provenance) return EMPTY_DEPENDENCY_ARTIFACT_RECEIPTS;
  if (
    !isWorkerCapabilityAssignmentProvenanceValid(
      provenance,
      call,
      provenance.requestId,
    )
  ) {
    throw new Error("worker_assignment_provenance_receipt_invalid");
  }
  const authority = readWorkerAssignmentAuthority(provenance);
  if (!authority || authority.head.revision !== provenance.sourceRevision) {
    throw new Error("worker_assignment_provenance_receipt_invalid");
  }
  const dependencies = projectRoleCallDependencyResults(authority.head, call);
  const receipts = dependencies.flatMap((dependency) => {
    if (dependency.roleId !== "worker" || dependency.outcome !== "completed") {
      return [];
    }
    return projectDependencyProducerArtifactReceipts(
      authority.head,
      dependency.producerCallId,
    );
  });
  return Object.freeze(receipts);
}

function projectDependencyProducerArtifactReceipts(
  head: RoleCallLedgerHead,
  producerCallId: string,
): readonly WorkerCapabilityDependencyArtifactReceipt[] {
  const receipts: WorkerCapabilityDependencyArtifactReceipt[] = [];
  for (const execution of head.state.capabilityExecutions) {
    if (execution.callId !== producerCallId) continue;
    if (execution.status !== "settled" || execution.outcome !== "succeeded") {
      continue;
    }
    for (const reference of execution.references ?? []) {
      receipts.push(
        Object.freeze({
          sourceExecutionId: execution.executionId,
          targetPath: reference.target,
        }),
      );
    }
  }
  return receipts;
}

function assertPlannerItemIsActive(
  head: RoleCallLedgerHead,
  binding: WorkerCapabilityPlannerItemBinding,
): void {
  const plan = head.state.plans.find(
    ({ definition }) => definition.planId === binding.planId,
  );
  if (!plan) {
    throw new Error("worker_assignment_provenance_plan_binding_invalid");
  }
  const item = plan?.itemStates.find(({ itemId }) => itemId === binding.itemId);
  if (!item || item.childCallId !== binding.workerCallId) {
    throw new Error("worker_assignment_provenance_plan_binding_invalid");
  }
  if (item.status !== "in_progress") {
    throw new Error("worker_assignment_provenance_plan_binding_invalid");
  }
}

function readWorkerAssignmentAuthority(
  provenance: WorkerCapabilityAssignmentProvenance,
): WorkerAssignmentAuthority | undefined {
  if (typeof provenance !== "object" || provenance === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(
    provenance,
    WORKER_ASSIGNMENT_AUTHORITY,
  );
  if (
    !descriptor ||
    descriptor.enumerable ||
    descriptor.configurable ||
    descriptor.writable
  ) {
    return undefined;
  }
  const authority: unknown = descriptor.value;
  if (typeof authority !== "object" || authority === null) return undefined;
  if (!Object.isFrozen(authority)) return undefined;
  const candidate = authority as WorkerAssignmentAuthority;
  return candidate.receipt === provenance ? candidate : undefined;
}
