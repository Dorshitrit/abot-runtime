import {
  isRoleOperationFingerprint,
  type RoleCallDependencyResult,
  type RoleCallFrame,
} from "../../role-calls/index.js";
import { validateWorkerCapabilityAcceptedControls } from "../controls.js";
import type {
  WorkerCapabilityAdapter,
  WorkerCapabilityAdapterExecutionInput,
  WorkerCapabilityControls,
  WorkerCapabilityExecutionFreshness,
  WorkerCapabilityPayloadSourceProvenance,
  WorkerCapabilityPreparedExecution,
  WorkerSettledCapabilityResult,
} from "../contracts.js";
import { createWorkerCapabilityDirectActionFingerprint } from "../preparation-fingerprint.js";
import { createWorkerCapabilityPreparationFailureFingerprint } from "../preparation-fingerprint.js";

export type PreparedBoundInvocation<TContext> = Readonly<{
  adapter: WorkerCapabilityAdapter<TContext>;
  intent: string;
  authoringObjective?: string;
  controls: WorkerCapabilityControls;
  prepared: WorkerCapabilityPreparedExecution;
}>;

type BoundInvocationPreparationParams<TContext> = Readonly<{
  context: TContext;
  call: RoleCallFrame;
  assignmentProvenance?: WorkerCapabilityPayloadSourceProvenance;
  adapter: WorkerCapabilityAdapter<TContext>;
  intent: string;
  authoringObjective?: string;
  controls: WorkerCapabilityControls;
  preparationId: string;
  settledCapabilityResults: readonly WorkerSettledCapabilityResult[];
  dependencyResults?: readonly RoleCallDependencyResult[];
  executionFreshness?: WorkerCapabilityExecutionFreshness;
}>;

type CommonBoundInvocationInput<TContext> = Readonly<
  Omit<WorkerCapabilityAdapterExecutionInput<TContext>, "executionId">
>;

export async function prepareBoundInvocation<TContext>(
  params: BoundInvocationPreparationParams<TContext>,
): Promise<WorkerCapabilityPreparedExecution> {
  const common = Object.freeze({
    context: params.context,
    call: params.call,
    ...(params.assignmentProvenance
      ? { assignmentProvenance: params.assignmentProvenance }
      : {}),
    intent: params.intent,
    ...(params.authoringObjective
      ? { authoringObjective: params.authoringObjective }
      : {}),
    controls: params.controls,
    settledCapabilityResults: params.settledCapabilityResults,
    ...(params.dependencyResults
      ? { dependencyResults: params.dependencyResults }
      : {}),
    ...(params.executionFreshness
      ? { executionFreshness: params.executionFreshness }
      : {}),
  });
  if (!params.adapter.prepare) {
    return prepareDirectInvocation(params, common);
  }
  try {
    const prepared = await params.adapter.prepare(
      Object.freeze({ ...common, preparationId: params.preparationId }),
    );
    if (!hasPreparedExecutionContract(prepared)) {
      throw createAdapterPreparationContractError("prepared_execution_invalid");
    }
    if (!isRoleOperationFingerprint(prepared.actionFingerprint)) {
      throw createAdapterPreparationContractError(
        "prepared_action_fingerprint_invalid",
      );
    }
    const acceptedControls = validateWorkerCapabilityAcceptedControls(
      prepared.acceptedControls,
    );
    if (!acceptedControls.ok) {
      throw createAdapterPreparationContractError(
        "prepared_accepted_controls_invalid",
      );
    }
    return Object.freeze({
      actionFingerprint: prepared.actionFingerprint,
      acceptedControls: acceptedControls.value,
      execute: prepared.execute,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return createPreparationFailureExecution(params, error);
  }
}

function prepareDirectInvocation<TContext>(
  params: BoundInvocationPreparationParams<TContext>,
  common: CommonBoundInvocationInput<TContext>,
): WorkerCapabilityPreparedExecution {
  const actionFingerprint = createWorkerCapabilityDirectActionFingerprint({
    capabilityId: params.adapter.descriptor.capabilityId,
    controls: params.controls,
    ...(params.call.workingDirectory
      ? { workingDirectory: params.call.workingDirectory }
      : {}),
  });
  if (!actionFingerprint) {
    return createPreparationFailureExecution(
      params,
      createAdapterPreparationContractError(
        "direct_action_fingerprint_invalid",
      ),
    );
  }
  return Object.freeze({
    actionFingerprint,
    acceptedControls: params.controls,
    execute: (executionId: string) =>
      params.adapter.execute(Object.freeze({ ...common, executionId })),
  });
}

export function deduplicatePreparedInvocations<TContext>(
  invocations: readonly PreparedBoundInvocation<TContext>[],
): readonly PreparedBoundInvocation<TContext>[] {
  const fingerprintsByCapability = new Map<string, Set<string>>();
  return Object.freeze(
    invocations.filter(({ adapter, prepared }) => {
      const fingerprint = prepared.actionFingerprint;
      if (!fingerprint) return true;
      const capabilityId = adapter.descriptor.capabilityId;
      const fingerprints =
        fingerprintsByCapability.get(capabilityId) ?? new Set<string>();
      if (fingerprints.has(fingerprint)) return false;
      fingerprints.add(fingerprint);
      fingerprintsByCapability.set(capabilityId, fingerprints);
      return true;
    }),
  );
}

export function createPreparationId(
  call: RoleCallFrame,
  index: number,
): string {
  return `capability-preparation:${call.callId}:${call.activationCount}:${index + 1}`;
}

function hasPreparedExecutionContract(
  prepared: unknown,
): prepared is WorkerCapabilityPreparedExecution {
  return (
    typeof prepared === "object" &&
    prepared !== null &&
    typeof (prepared as { execute?: unknown }).execute === "function"
  );
}

function createPreparationFailureExecution<TContext>(
  params: Pick<
    BoundInvocationPreparationParams<TContext>,
    "adapter" | "call" | "controls"
  >,
  error: unknown,
): WorkerCapabilityPreparedExecution {
  const actionFingerprint = createWorkerCapabilityPreparationFailureFingerprint(
    {
      capabilityId: params.adapter.descriptor.capabilityId,
      controls: params.controls,
      ...(params.call.workingDirectory
        ? { workingDirectory: params.call.workingDirectory }
        : {}),
      error,
    },
  );
  return Object.freeze({
    ...(actionFingerprint ? { actionFingerprint } : {}),
    acceptedControls: params.controls,
    execute: async () => {
      throw error;
    },
  });
}

function createAdapterPreparationContractError(issueCode: string): Error {
  return Object.assign(
    new Error(
      `worker_capability_adapter_preparation_contract_rejected:${issueCode}`,
    ),
    {
      name: "WorkerCapabilityAdapterContractError",
      issueCode,
    },
  );
}
