import type {
  RoleCallFrame,
  RoleCallLedger,
  RoleCallLedgerHead,
} from "../role-calls/contracts.js";
import { isCurrentRoleCallLedgerHead } from "../role-calls/ledger.js";
import {
  isWorkerCapabilityAssignmentProvenanceValid,
  projectWorkerCapabilityAssignmentProvenance,
} from "./assignment-provenance.js";
import type {
  WorkerCapabilityAssignmentProvenance,
  WorkerCapabilityPayloadSourceProvenance,
  WorkerCapabilityRequestScopedProvenance,
} from "./contracts.js";

const WORKER_PAYLOAD_REQUEST_AUTHORITY = Symbol(
  "workerPayloadRequestAuthority",
);

type WorkerPayloadRequestAuthority = Readonly<{
  receipt: object;
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  caller: RoleCallFrame;
}>;

/** Issues the exact request-source receipt for one canonical Worker payload. */
export function projectWorkerCapabilityPayloadSourceProvenance(
  params: Readonly<{
    ledger: RoleCallLedger;
    head: RoleCallLedgerHead;
    call: RoleCallFrame;
  }>,
): WorkerCapabilityPayloadSourceProvenance {
  assertCanonicalPayloadSourceAuthority(params);
  const assignment = projectWorkerCapabilityAssignmentProvenance(params);
  if (assignment) return assignment;
  return issueRequestScopedWorkerProvenance(params);
}

/** Validates a payload-only receipt against its exact consuming Worker call. */
export function isWorkerCapabilityPayloadSourceProvenanceValid(
  provenance: WorkerCapabilityPayloadSourceProvenance | undefined,
  call: RoleCallFrame,
  requestId: string,
): boolean {
  if (!provenance) return false;
  if (provenance.kind === "planner_plan_item_v1") {
    return isWorkerCapabilityAssignmentProvenanceValid(
      provenance,
      call,
      requestId,
    );
  }
  if (provenance.kind !== "request_scoped_worker_v1") return false;
  const authority = readWorkerPayloadRequestAuthority(provenance);
  if (!authority || !Object.isFrozen(provenance)) return false;
  if (authority.head.state.requestId !== requestId) return false;
  if (authority.head.revision !== provenance.sourceRevision) return false;
  if (authority.call !== call || call.roleId !== "worker") return false;
  if (provenance.requestId !== requestId) return false;
  if (provenance.workerCallId !== call.callId) return false;
  if (provenance.callerCallId !== call.parentCallId) return false;
  if (provenance.invocationAttempt !== call.activationCount) return false;
  return isCanonicalRequestScopedWorker(authority);
}

/** Resolves Worker payload request scope only from a verified runtime receipt. */
export function projectWorkerPayloadRequestSourceProjection(
  provenance: WorkerCapabilityPayloadSourceProvenance | undefined,
  call: RoleCallFrame,
  requestId: string,
): "full_request" | "assignment_only" {
  if (
    !isWorkerCapabilityPayloadSourceProvenanceValid(provenance, call, requestId)
  ) {
    throw new Error("worker_payload_source_provenance_receipt_invalid");
  }
  return provenance?.kind === "planner_plan_item_v1"
    ? "assignment_only"
    : "full_request";
}

/** Narrows a validated payload receipt to Planner-only dependency authority. */
export function projectWorkerPayloadPlannerItemProvenance(
  provenance: WorkerCapabilityPayloadSourceProvenance | undefined,
  call: RoleCallFrame,
): WorkerCapabilityAssignmentProvenance | undefined {
  if (!provenance) return undefined;
  if (
    !isWorkerCapabilityPayloadSourceProvenanceValid(
      provenance,
      call,
      provenance.requestId,
    )
  ) {
    throw new Error("worker_payload_source_provenance_receipt_invalid");
  }
  return provenance.kind === "planner_plan_item_v1" ? provenance : undefined;
}

function issueRequestScopedWorkerProvenance(
  params: Readonly<{
    ledger: RoleCallLedger;
    head: RoleCallLedgerHead;
    call: RoleCallFrame;
  }>,
): WorkerCapabilityRequestScopedProvenance {
  const canonicalCall = params.head.state.calls.find(
    ({ callId }) => callId === params.call.callId,
  );
  if (canonicalCall !== params.call || canonicalCall.roleId !== "worker") {
    throw new Error("worker_payload_source_provenance_authority_invalid");
  }
  const caller = params.head.state.calls.find(
    ({ callId }) => callId === canonicalCall.parentCallId,
  );
  if (
    !caller ||
    caller.roleId === "planner" ||
    caller.depth !== canonicalCall.depth - 1
  ) {
    throw new Error("worker_payload_source_provenance_parent_invalid");
  }
  const provenance = {
    kind: "request_scoped_worker_v1" as const,
    requestId: params.head.state.requestId,
    sourceRevision: params.head.revision,
    callerCallId: caller.callId,
    workerCallId: canonicalCall.callId,
    invocationAttempt: canonicalCall.activationCount,
  };
  const authority = Object.freeze({
    receipt: provenance,
    head: params.head,
    call: canonicalCall,
    caller,
  });
  Object.defineProperty(provenance, WORKER_PAYLOAD_REQUEST_AUTHORITY, {
    value: authority,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(provenance) as WorkerCapabilityRequestScopedProvenance;
}

function assertCanonicalPayloadSourceAuthority(
  params: Readonly<{
    ledger: RoleCallLedger;
    head: RoleCallLedgerHead;
    call: RoleCallFrame;
  }>,
): void {
  const canonicalCall = params.head.state.calls.find(
    ({ callId }) => callId === params.call.callId,
  );
  const hasActiveWorkerAuthority =
    canonicalCall === params.call &&
    canonicalCall.roleId === "worker" &&
    canonicalCall.status === "active" &&
    canonicalCall.resultRef === null &&
    Number.isInteger(canonicalCall.activationCount) &&
    canonicalCall.activationCount >= 1 &&
    params.head.state.activeCallId === canonicalCall.callId &&
    params.head.policy.authority.capabilityAuthorities.includes("worker");
  if (
    !isCurrentRoleCallLedgerHead(params.ledger, params.head) ||
    !hasActiveWorkerAuthority
  ) {
    throw new Error("worker_payload_source_provenance_authority_invalid");
  }
}

function isCanonicalRequestScopedWorker(
  authority: WorkerPayloadRequestAuthority,
): boolean {
  const canonicalCall = authority.head.state.calls.find(
    ({ callId }) => callId === authority.call.callId,
  );
  const canonicalCaller = authority.head.state.calls.find(
    ({ callId }) => callId === authority.caller.callId,
  );
  return (
    canonicalCall === authority.call &&
    canonicalCaller === authority.caller &&
    authority.call.parentCallId === authority.caller.callId &&
    authority.caller.roleId !== "planner" &&
    authority.caller.depth === authority.call.depth - 1
  );
}

function readWorkerPayloadRequestAuthority(
  provenance: WorkerCapabilityRequestScopedProvenance,
): WorkerPayloadRequestAuthority | undefined {
  if (typeof provenance !== "object" || provenance === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(
    provenance,
    WORKER_PAYLOAD_REQUEST_AUTHORITY,
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
  const candidate = authority as WorkerPayloadRequestAuthority;
  return candidate.receipt === provenance ? candidate : undefined;
}
