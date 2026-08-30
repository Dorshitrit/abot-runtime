import type {
  RoleCallFrame,
  RoleCallLedger,
  RoleCallLedgerHead,
} from "../../role-calls/index.js";
import type {
  WorkerCapabilityDescriptor,
  WorkerSettledCapabilityResult,
} from "../contracts.js";
import {
  traceWorkerCapabilityContextProjected,
  traceWorkerCapabilityContextRejected,
  type WorkerCapabilityDiagnosticContext,
} from "../diagnostics.js";
import { projectWorkerSettledCapabilityResults } from "../settled-results.js";
import {
  assertWorkerCapabilityWithinScope,
  WorkerCapabilityScopeError,
  type WorkerCapabilityScopeProjection,
} from "../scope.js";

export function assertExecutionCapabilityScope(
  projection: WorkerCapabilityScopeProjection<unknown>,
  descriptor: WorkerCapabilityDescriptor,
  diagnostic: WorkerCapabilityDiagnosticContext,
): void {
  try {
    assertWorkerCapabilityWithinScope(projection, descriptor);
  } catch (error: unknown) {
    const issueCode =
      error instanceof WorkerCapabilityScopeError
        ? error.issueCode
        : "capability_scope_validation_failed";
    traceWorkerCapabilityContextRejected(diagnostic, descriptor, issueCode);
    throw new Error(`worker_capability_rejected:${issueCode}`);
  }
}

export function projectExecutionSettledCapabilityResults(params: {
  ledger: RoleCallLedger;
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  descriptors: readonly WorkerCapabilityDescriptor[];
  diagnostic: WorkerCapabilityDiagnosticContext;
}): readonly WorkerSettledCapabilityResult[] {
  let settledCapabilityResults: readonly WorkerSettledCapabilityResult[];
  try {
    settledCapabilityResults = projectWorkerSettledCapabilityResults({
      ledger: params.ledger,
      head: params.head,
      call: params.call,
    });
  } catch (error: unknown) {
    const issueCode = settledResultProjectionIssueCode(error);
    for (const descriptor of params.descriptors) {
      traceWorkerCapabilityContextRejected(
        params.diagnostic,
        descriptor,
        issueCode,
      );
    }
    throw new Error(`worker_capability_context_rejected:${issueCode}`);
  }
  for (const descriptor of params.descriptors) {
    traceWorkerCapabilityContextProjected(
      params.diagnostic,
      descriptor,
      settledCapabilityResults,
    );
  }
  return settledCapabilityResults;
}

function settledResultProjectionIssueCode(error: unknown): string {
  if (!(error instanceof Error)) {
    return "worker_settled_results_projection_failed";
  }
  if (error.message === "worker_settled_results_head_stale") {
    return error.message;
  }
  if (error.message === "worker_settled_results_call_invalid") {
    return error.message;
  }
  if (error.message === "worker_settled_results_execution_invalid") {
    return error.message;
  }
  return "worker_settled_results_projection_failed";
}
