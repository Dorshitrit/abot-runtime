import {
  parseRoleCallWorkerCapabilityScope,
  type RoleCallDependencyResult,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../../role-calls/index.js";
import type {
  WorkerCapabilityAdapter,
  WorkerCapabilityBinding,
  WorkerCapabilityExecutionFreshness,
} from "../contracts.js";
import {
  traceWorkerCapabilityBindingCreated,
  traceWorkerCapabilityBindingRejected,
  type WorkerCapabilityDiagnosticContext,
} from "../diagnostics.js";
import type { WorkerCapabilityScopeProjection } from "../scope.js";
import { createBoundCapabilityCatalog } from "./adapter-catalog.js";
import { workerCapabilityBindingRejection } from "./binding-rejection.js";
import { BoundCapabilitySession } from "./bound-capability-session.js";
import {
  copyBoundCapabilityCall,
  inspectInitialBindingAuthority,
  normalizeExecutionFreshness,
} from "./call-authority.js";
import { bindCapabilityDependencyResults } from "./dependency-results.js";

export function createRoleCapabilityBinding<TContext>(params: {
  requestId: string;
  context: TContext;
  call: RoleCallFrame;
  ledger: RoleCallLedger;
  adapters: readonly WorkerCapabilityAdapter<TContext>[];
  dependencyResults?: readonly RoleCallDependencyResult[];
  executionFreshness?: WorkerCapabilityExecutionFreshness;
}): WorkerCapabilityBinding<TContext> {
  const boundCall = copyBoundCapabilityCall(params.call);
  const emptyDiagnostic = createEmptyBindingDiagnostic(
    params.requestId,
    boundCall,
  );
  const executionFreshness = resolveBoundExecutionFreshness({
    boundCall,
    supplied: params.executionFreshness,
    emptyDiagnostic,
  });
  const initialHead = readInitialLedgerHead(params.ledger, emptyDiagnostic);
  const authority = inspectInitialBindingAuthority({
    requestId: params.requestId,
    boundCall,
    initialHead,
  });
  if (!authority.ok) {
    traceWorkerCapabilityBindingRejected(emptyDiagnostic, authority.issueCode);
    throw workerCapabilityBindingRejection(authority.issueCode);
  }
  const dependencyResults = resolveBoundDependencyResults({
    initialHead,
    authoritativeCall: authority.authoritativeCall,
    supplied: params.dependencyResults,
    emptyDiagnostic,
  });
  const catalog = createBoundCapabilityCatalog({
    adapters: params.adapters,
    boundCall,
    emptyDiagnostic,
  });
  const diagnostic = createBindingDiagnostic({
    requestId: params.requestId,
    boundCall,
    capabilityScope: catalog.capabilityScope,
  });
  traceWorkerCapabilityBindingCreated(diagnostic);

  const session = new BoundCapabilitySession({
    requestId: params.requestId,
    context: params.context,
    boundCall,
    ledger: params.ledger,
    capabilities: catalog.capabilities,
    byCapabilityId: catalog.byCapabilityId,
    diagnostic,
    capabilityScope: catalog.capabilityScope,
    dependencyResults,
    ...(executionFreshness ? { executionFreshness } : {}),
  });
  return session.toBinding();
}

function createEmptyBindingDiagnostic(
  requestId: string,
  boundCall: RoleCallFrame,
): WorkerCapabilityDiagnosticContext {
  const diagnosticScope = parseRoleCallWorkerCapabilityScope(
    boundCall.workerCapabilityScope,
  );
  return {
    requestId,
    call: boundCall,
    capabilityIds: Object.freeze([]),
    scopeMode:
      boundCall.workerCapabilityScope === undefined ? "full" : "catalog_groups",
    scopeCatalogGroupIds: diagnosticScope?.catalogGroupIds ?? Object.freeze([]),
    knownCatalogGroupCount: 0,
    fullCapabilityCount: 0,
    filteredCapabilityCount: 0,
  };
}

function resolveBoundExecutionFreshness(params: {
  boundCall: RoleCallFrame;
  supplied: WorkerCapabilityExecutionFreshness | undefined;
  emptyDiagnostic: WorkerCapabilityDiagnosticContext;
}): WorkerCapabilityExecutionFreshness | undefined {
  const executionFreshness =
    params.boundCall.parentCallId === null
      ? normalizeExecutionFreshness(params.supplied)
      : undefined;
  const hasInvalidFreshness =
    params.supplied !== undefined && !executionFreshness;
  if (!hasInvalidFreshness) return executionFreshness;
  traceWorkerCapabilityBindingRejected(
    params.emptyDiagnostic,
    "execution_freshness_invalid",
  );
  throw workerCapabilityBindingRejection("execution_freshness_invalid");
}

function readInitialLedgerHead(
  ledger: RoleCallLedger,
  emptyDiagnostic: WorkerCapabilityDiagnosticContext,
): RoleCallLedgerHead {
  try {
    return ledger.current();
  } catch {
    traceWorkerCapabilityBindingRejected(
      emptyDiagnostic,
      "current_call_read_failed",
    );
    throw workerCapabilityBindingRejection("current_call_read_failed");
  }
}

function resolveBoundDependencyResults(params: {
  initialHead: RoleCallLedgerHead;
  authoritativeCall: RoleCallFrame;
  supplied: readonly RoleCallDependencyResult[] | undefined;
  emptyDiagnostic: WorkerCapabilityDiagnosticContext;
}): readonly RoleCallDependencyResult[] {
  try {
    return bindCapabilityDependencyResults(
      params.initialHead,
      params.authoritativeCall,
      params.supplied,
    );
  } catch {
    traceWorkerCapabilityBindingRejected(
      params.emptyDiagnostic,
      "dependency_results_invalid",
    );
    throw workerCapabilityBindingRejection("dependency_results_invalid");
  }
}

function createBindingDiagnostic<TContext>(params: {
  requestId: string;
  boundCall: RoleCallFrame;
  capabilityScope: WorkerCapabilityScopeProjection<
    WorkerCapabilityAdapter<TContext>
  >;
}): WorkerCapabilityDiagnosticContext {
  return Object.freeze({
    requestId: params.requestId,
    call: params.boundCall,
    capabilityIds: params.capabilityScope.filteredCapabilityIds,
    scopeMode: params.capabilityScope.mode,
    scopeCatalogGroupIds: params.capabilityScope.catalogGroupIds,
    knownCatalogGroupCount: params.capabilityScope.knownCatalogGroupIds.length,
    fullCapabilityCount: params.capabilityScope.fullCapabilityIds.length,
    filteredCapabilityCount:
      params.capabilityScope.filteredCapabilityIds.length,
  });
}
