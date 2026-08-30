import type { RoleCallFrame } from "../../role-calls/index.js";
import {
  WORKER_CAPABILITY_COUNT_MAX,
  type WorkerCapabilityAdapter,
  type WorkerCapabilityDescriptor,
} from "../contracts.js";
import {
  traceWorkerCapabilityBindingRejected,
  type WorkerCapabilityDiagnosticContext,
} from "../diagnostics.js";
import {
  projectWorkerCapabilityCatalogGroups,
  projectWorkerCapabilityScope,
  WorkerCapabilityScopeError,
  type WorkerCapabilityScopeProjection,
} from "../scope.js";
import { normalizeCapabilityAdapter } from "./adapter-normalization.js";
import { workerCapabilityBindingRejection } from "./binding-rejection.js";

export type BoundCapabilityCatalog<TContext> = Readonly<{
  capabilities: readonly WorkerCapabilityDescriptor[];
  byCapabilityId: ReadonlyMap<string, WorkerCapabilityAdapter<TContext>>;
  capabilityScope: WorkerCapabilityScopeProjection<
    WorkerCapabilityAdapter<TContext>
  >;
}>;

export function createBoundCapabilityCatalog<TContext>(params: {
  adapters: readonly WorkerCapabilityAdapter<TContext>[];
  boundCall: RoleCallFrame;
  emptyDiagnostic: WorkerCapabilityDiagnosticContext;
}): BoundCapabilityCatalog<TContext> {
  assertValidCapabilityCount(params.adapters, params.emptyDiagnostic);
  const boundAdapters = normalizeCapabilityAdapters(
    params.adapters,
    params.emptyDiagnostic,
  );
  const capabilityScope = projectBoundCapabilityScope({
    boundAdapters,
    boundCall: params.boundCall,
    emptyDiagnostic: params.emptyDiagnostic,
  });
  const scopedAdapters = capabilityScope.entries;
  return Object.freeze({
    capabilities: Object.freeze(
      scopedAdapters.map((adapter) => adapter.descriptor),
    ),
    byCapabilityId: new Map(
      scopedAdapters.map((adapter) => [
        adapter.descriptor.capabilityId,
        adapter,
      ]),
    ),
    capabilityScope,
  });
}

function assertValidCapabilityCount<TContext>(
  adapters: readonly WorkerCapabilityAdapter<TContext>[],
  diagnostic: WorkerCapabilityDiagnosticContext,
): void {
  const hasInvalidCapabilityCount =
    !Array.isArray(adapters) || adapters.length > WORKER_CAPABILITY_COUNT_MAX;
  if (!hasInvalidCapabilityCount) return;
  traceWorkerCapabilityBindingRejected(diagnostic, "capability_count_invalid");
  throw workerCapabilityBindingRejection("capability_count_invalid");
}

function normalizeCapabilityAdapters<TContext>(
  adapters: readonly WorkerCapabilityAdapter<TContext>[],
  diagnostic: WorkerCapabilityDiagnosticContext,
): readonly WorkerCapabilityAdapter<TContext>[] {
  const normalizedAdapters: WorkerCapabilityAdapter<TContext>[] = [];
  const seenCapabilityIds = new Set<string>();
  for (const adapter of adapters) {
    const normalized = normalizeCapabilityAdapter(adapter);
    if (!normalized.ok) {
      rejectAdapterCatalog(diagnostic, seenCapabilityIds, normalized.issueCode);
    }
    const capabilityId = normalized.value.descriptor.capabilityId;
    if (seenCapabilityIds.has(capabilityId)) {
      rejectAdapterCatalog(
        diagnostic,
        seenCapabilityIds,
        "duplicate_capability_id",
      );
    }
    seenCapabilityIds.add(capabilityId);
    normalizedAdapters.push(normalized.value);
  }
  return normalizedAdapters;
}

function projectBoundCapabilityScope<TContext>(params: {
  boundAdapters: readonly WorkerCapabilityAdapter<TContext>[];
  boundCall: RoleCallFrame;
  emptyDiagnostic: WorkerCapabilityDiagnosticContext;
}): WorkerCapabilityScopeProjection<WorkerCapabilityAdapter<TContext>> {
  const knownCatalogGroups = projectWorkerCapabilityCatalogGroups(
    params.boundAdapters.map((adapter) => adapter.descriptor),
  );
  try {
    return projectWorkerCapabilityScope({
      entries: params.boundAdapters,
      scope: params.boundCall.workerCapabilityScope,
      descriptorOf: (adapter) => adapter.descriptor,
    });
  } catch (error: unknown) {
    const issueCode =
      error instanceof WorkerCapabilityScopeError
        ? error.issueCode
        : "capability_scope_projection_invalid";
    traceWorkerCapabilityBindingRejected(
      {
        ...params.emptyDiagnostic,
        capabilityIds: Object.freeze(
          params.boundAdapters.map(
            (adapter) => adapter.descriptor.capabilityId,
          ),
        ),
        knownCatalogGroupCount: knownCatalogGroups.length,
        fullCapabilityCount: params.boundAdapters.length,
      },
      issueCode,
    );
    throw workerCapabilityBindingRejection(issueCode);
  }
}

function rejectAdapterCatalog(
  diagnostic: WorkerCapabilityDiagnosticContext,
  seenCapabilityIds: ReadonlySet<string>,
  issueCode: string,
): never {
  traceWorkerCapabilityBindingRejected(
    {
      ...diagnostic,
      capabilityIds: Object.freeze([...seenCapabilityIds]),
    },
    issueCode,
  );
  throw workerCapabilityBindingRejection(issueCode);
}
