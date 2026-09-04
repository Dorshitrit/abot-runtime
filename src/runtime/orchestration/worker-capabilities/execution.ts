import type {
  RoleCallDependencyResult,
  RoleCallFrame,
  RoleCallLedger,
  RoleCallLedgerHead,
} from "../role-calls/index.js";
import type {
  WorkerCapabilityAdapter,
  WorkerCapabilityAttemptReference,
  WorkerCapabilityBatchAttemptReference,
  WorkerCapabilityControls,
  WorkerCapabilityExecutionFreshness,
} from "./contracts.js";
import type { WorkerCapabilityDiagnosticContext } from "./diagnostics.js";
import {
  assertExecutionCapabilityScope,
  projectExecutionSettledCapabilityResults,
} from "./execution/context-projection.js";
import {
  createPreparationId,
  deduplicatePreparedInvocations,
  prepareBoundInvocation,
  type PreparedBoundInvocation,
} from "./execution/invocation-preparation.js";
import {
  beginAndSettlePreparedBatch,
  beginAndSettlePreparedSingle,
} from "./execution/ledger-transaction.js";
import type { WorkerCapabilityScopeProjection } from "./scope.js";
import { projectWorkerCapabilityPayloadSourceProvenance } from "./payload-source-provenance.js";

type PreparedInvocationBatchSettlement<TContext> = Readonly<{
  currentHead: RoleCallLedgerHead;
  ledger: RoleCallLedger;
  call: RoleCallFrame;
  invocations: readonly PreparedBoundInvocation<TContext>[];
  diagnostic: WorkerCapabilityDiagnosticContext;
  executionFreshness?: WorkerCapabilityExecutionFreshness;
}>;

export async function executeBoundWorkerCapability<TContext>(params: {
  context: TContext;
  call: RoleCallFrame;
  currentHead: RoleCallLedgerHead;
  ledger: RoleCallLedger;
  adapter: WorkerCapabilityAdapter<TContext>;
  intent: string;
  authoringObjective?: string;
  controls: WorkerCapabilityControls;
  diagnostic: WorkerCapabilityDiagnosticContext;
  capabilityScope: WorkerCapabilityScopeProjection<unknown>;
  dependencyResults?: readonly RoleCallDependencyResult[];
  executionFreshness?: WorkerCapabilityExecutionFreshness;
}): Promise<WorkerCapabilityAttemptReference> {
  assertExecutionCapabilityScope(
    params.capabilityScope,
    params.adapter.descriptor,
    params.diagnostic,
  );
  const settledCapabilityResults = projectExecutionSettledCapabilityResults({
    ledger: params.ledger,
    head: params.currentHead,
    call: params.call,
    descriptors: [params.adapter.descriptor],
    diagnostic: params.diagnostic,
  });
  const assignmentProvenance = projectPayloadSourceProvenance(params);
  const prepared = await prepareBoundInvocation({
    context: params.context,
    call: params.call,
    ...(assignmentProvenance ? { assignmentProvenance } : {}),
    adapter: params.adapter,
    intent: params.intent,
    ...(params.authoringObjective
      ? { authoringObjective: params.authoringObjective }
      : {}),
    controls: params.controls,
    preparationId: createPreparationId(params.call, 0),
    settledCapabilityResults,
    ...(params.dependencyResults
      ? { dependencyResults: params.dependencyResults }
      : {}),
    ...(params.executionFreshness
      ? { executionFreshness: params.executionFreshness }
      : {}),
  });
  return beginAndSettlePreparedSingle({
    currentHead: params.currentHead,
    ledger: params.ledger,
    call: params.call,
    invocation: Object.freeze({
      adapter: params.adapter,
      intent: params.intent,
      ...(params.authoringObjective
        ? { authoringObjective: params.authoringObjective }
        : {}),
      controls: params.controls,
      prepared,
    }),
    diagnostic: params.diagnostic,
    ...(params.executionFreshness
      ? { executionFreshness: params.executionFreshness }
      : {}),
  });
}

export async function executeBoundWorkerCapabilityBatch<TContext>(params: {
  context: TContext;
  call: RoleCallFrame;
  currentHead: RoleCallLedgerHead;
  ledger: RoleCallLedger;
  invocations: readonly Readonly<{
    adapter: WorkerCapabilityAdapter<TContext>;
    intent: string;
    authoringObjective?: string;
    controls: WorkerCapabilityControls;
  }>[];
  diagnostic: WorkerCapabilityDiagnosticContext;
  capabilityScope: WorkerCapabilityScopeProjection<unknown>;
  dependencyResults?: readonly RoleCallDependencyResult[];
  executionFreshness?: WorkerCapabilityExecutionFreshness;
}): Promise<WorkerCapabilityBatchAttemptReference> {
  if (!isExecutableObservationBatch(params.invocations)) {
    throw new Error("worker_capability_batch_invalid");
  }
  for (const { adapter } of params.invocations) {
    assertExecutionCapabilityScope(
      params.capabilityScope,
      adapter.descriptor,
      params.diagnostic,
    );
  }
  const settledCapabilityResults = projectExecutionSettledCapabilityResults({
    ledger: params.ledger,
    head: params.currentHead,
    call: params.call,
    descriptors: params.invocations.map(({ adapter }) => adapter.descriptor),
    diagnostic: params.diagnostic,
  });
  const preparedInvocations = await Promise.all(
    params.invocations.map(async (invocation, index) => {
      const assignmentProvenance = projectPayloadSourceProvenance({
        ledger: params.ledger,
        currentHead: params.currentHead,
        call: params.call,
        adapter: invocation.adapter,
      });
      return Object.freeze({
        ...invocation,
        prepared: await prepareBoundInvocation({
          context: params.context,
          call: params.call,
          ...(assignmentProvenance ? { assignmentProvenance } : {}),
          adapter: invocation.adapter,
          intent: invocation.intent,
          ...(invocation.authoringObjective
            ? { authoringObjective: invocation.authoringObjective }
            : {}),
          controls: invocation.controls,
          preparationId: createPreparationId(params.call, index),
          settledCapabilityResults,
          ...(params.dependencyResults
            ? { dependencyResults: params.dependencyResults }
            : {}),
          ...(params.executionFreshness
            ? { executionFreshness: params.executionFreshness }
            : {}),
        }),
      });
    }),
  );
  const uniqueInvocations = deduplicatePreparedInvocations(preparedInvocations);
  return settlePreparedInvocationBatch({
    currentHead: params.currentHead,
    ledger: params.ledger,
    call: params.call,
    invocations: uniqueInvocations,
    diagnostic: params.diagnostic,
    ...(params.executionFreshness
      ? { executionFreshness: params.executionFreshness }
      : {}),
  });
}

function projectPayloadSourceProvenance<TContext>(
  params: Readonly<{
    ledger: RoleCallLedger;
    currentHead: RoleCallLedgerHead;
    call: RoleCallFrame;
    adapter: WorkerCapabilityAdapter<TContext> | undefined;
  }>,
) {
  if (
    params.call.roleId !== "worker" ||
    params.adapter?.descriptor.requiresPayloadAuthoringObjective !== true
  ) {
    return undefined;
  }
  return projectWorkerCapabilityPayloadSourceProvenance({
    ledger: params.ledger,
    head: params.currentHead,
    call: params.call,
  });
}

async function settlePreparedInvocationBatch<TContext>(
  params: PreparedInvocationBatchSettlement<TContext>,
): Promise<WorkerCapabilityBatchAttemptReference> {
  if (params.invocations.length === 1) {
    return settleCollapsedPreparedBatch(params);
  }
  return beginAndSettlePreparedBatch(params);
}

async function settleCollapsedPreparedBatch<TContext>(
  params: PreparedInvocationBatchSettlement<TContext>,
): Promise<WorkerCapabilityBatchAttemptReference> {
  const result = await beginAndSettlePreparedSingle({
    currentHead: params.currentHead,
    ledger: params.ledger,
    call: params.call,
    invocation: params.invocations[0]!,
    diagnostic: params.diagnostic,
    ...(params.executionFreshness
      ? { executionFreshness: params.executionFreshness }
      : {}),
  });
  return projectSingleAttemptAsBatch(result);
}

function projectSingleAttemptAsBatch(
  result: WorkerCapabilityAttemptReference,
): WorkerCapabilityBatchAttemptReference {
  if ("commit" in result) return result;
  return Object.freeze({
    executionIds: Object.freeze([result.executionId]),
  });
}

function isExecutableObservationBatch<TContext>(
  invocations: readonly Readonly<{
    adapter: WorkerCapabilityAdapter<TContext>;
  }>[],
): boolean {
  if (invocations.length < 2) return false;
  return invocations.every(
    ({ adapter }) => adapter.descriptor.effect === "observation",
  );
}
