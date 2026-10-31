import { projectSelectedDependencyObservations } from "./super-dependency-observation-lineage.js";
import { projectCurrentRequestToolResults } from "./request-tool-results-supersession.js";
import { projectCanonicalRequestToolResult } from "./canonical-capability-result.js";
import type { RoleCallLedgerHead } from "../orchestration/role-calls/index.js";
import type { SemanticCompactionSource } from "./semantic-compaction/contracts.js";
import {
  createCapabilityResultCompactionSource,
  isCanonicalSuperCapabilitySourceCall,
  projectCanonicalCapabilityResultCompactionSources,
} from "./capability-result-compaction-source.js";
import { hasSuperContextContract } from "./super-context-policy.js";

const SOURCE_BINDING = Symbol("superWorkerCompactionSources");

export type SuperWorkerCompactionSidecar = Readonly<{
  head: RoleCallLedgerHead;
  parentCallId: string | null;
  invocationAttempt: number;
  requestId: string;
  callId: string;
  sourceRevision: number;
  sources: readonly SemanticCompactionSource[];
  eligibleExecutionIds: readonly string[];
}>;

type CarrierBinding = Readonly<{
  carrier: object;
  sidecar: SuperWorkerCompactionSidecar;
}>;

/** Only a canonical SUPER capability owner may mint a non-serializable sidecar. */
export function bindSuperWorkerCompactionSources<T extends object>(
  carrier: T,
  head: RoleCallLedgerHead,
  callId: string,
): Readonly<T> {
  if (!hasSuperContextContract(head.policy.authority, "delegated.worker"))
    return Object.freeze(carrier);
  const call = head.state.calls.find(
    (candidate) => candidate.callId === callId,
  );
  if (!isCanonicalSuperCapabilitySourceCall(head, call)) return Object.freeze(carrier);
  // Root RAW uses settled-result arrays; routing views retain request-wide evidence.
  if (call.roleId === "supervisor" && !Array.isArray(carrier)) return Object.freeze(carrier);
  const results = head.state.capabilityExecutions
    .filter(
      (execution) =>
        execution.callId === callId && execution.status === "settled",
    )
    .map((execution) => projectCanonicalRequestToolResult(head, execution));
  const dependencyObservations = projectSelectedDependencyObservations(head, call);
  const eligibleExecutionIds = Object.freeze(
    [...projectCurrentRequestToolResults(results), ...dependencyObservations]
      .filter(
        (result) => result.summaryProjection !== "superseded_target_evidence",
      )
      .map((result) => result.executionId),
  );
  const sidecarFields = {
    parentCallId: call.parentCallId,
    invocationAttempt: call.activationCount,
    eligibleExecutionIds,
    requestId: head.state.requestId,
    callId,
    sourceRevision: head.revision,
    sources: Object.freeze([
      ...projectCanonicalCapabilityResultCompactionSources({ head, callId }),
      ...dependencyObservations.map(createCapabilityResultCompactionSource),
    ]),
  };
  Object.defineProperty(sidecarFields, "head", {
    value: head,
    enumerable: false,
  });
  const sidecar = Object.freeze(sidecarFields as SuperWorkerCompactionSidecar);
  Object.defineProperty(carrier, SOURCE_BINDING, {
    value: Object.freeze({ carrier, sidecar }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(carrier);
}

export function superPayloadCompactionContractId(
  sidecar: SuperWorkerCompactionSidecar,
): "supervisor" | "delegated.worker" {
  return sidecar.parentCallId === null ? "supervisor" : "delegated.worker";
}

/** Copying a carrier never copies authority, including object/array spread. */
export function readSuperWorkerCompactionSidecar(
  carrier: object,
): SuperWorkerCompactionSidecar | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(carrier, SOURCE_BINDING);
  if (!descriptor) return undefined;
  const binding = descriptor.value as CarrierBinding;
  if (
    !binding ||
    binding.carrier !== carrier ||
    !Object.isFrozen(binding) ||
    descriptor.enumerable
  ) {
    throw new Error("context_compaction_source_binding_invalid");
  }
  return binding.sidecar;
}

export function assertSuperWorkerCompactionSidecarBinding(
  sidecar: SuperWorkerCompactionSidecar,
  binding: Readonly<{
    requestId: string;
    callId: string;
    sourceRevision?: number;
  }>,
): void {
  if (sidecar.requestId !== binding.requestId)
    throw new Error("context_compaction_source_request_invalid");
  if (sidecar.callId !== binding.callId)
    throw new Error("context_compaction_source_call_invalid");
  if (
    binding.sourceRevision !== undefined &&
    sidecar.sourceRevision !== binding.sourceRevision
  ) {
    throw new Error("context_compaction_source_revision_invalid");
  }
}
