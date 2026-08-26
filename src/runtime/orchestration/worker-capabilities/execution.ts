import {
  ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH,
  ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX,
  ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  resolveRoleCallTransactions,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerHead,
  type RoleCallDependencyResult,
  type RoleCapabilityResultReference,
} from "../role-calls/index.js";
import type {
  WorkerCapabilityAdapter,
  WorkerCapabilityAdapterResult,
  WorkerCapabilityBatchExecutionReference,
  WorkerCapabilityExecutionReference,
  WorkerCapabilityExecutionFreshness,
  WorkerCapabilityControls,
  WorkerCapabilityDescriptor,
  WorkerCapabilityEffect,
  WorkerSettledCapabilityResult,
} from "./contracts.js";
import {
  traceWorkerCapabilityContextProjected,
  traceWorkerCapabilityContextRejected,
  traceWorkerCapabilityExecutionCompleted,
  traceWorkerCapabilityExecutionFailed,
  traceWorkerCapabilityExecutionStarted,
  traceWorkerCapabilityResultRejected,
  traceWorkerCapabilityStateRejected,
  type WorkerCapabilityDiagnosticContext,
} from "./diagnostics.js";
import { projectWorkerSettledCapabilityResults } from "./settled-results.js";
import {
  assertWorkerCapabilityWithinScope,
  WorkerCapabilityScopeError,
  type WorkerCapabilityScopeProjection,
} from "./scope.js";
import {
  captureLegacyCapabilityAdapterResult,
  normalizeCapabilityAdapterResult,
  type CapabilityAdapterResult,
} from "../capability-adapters/result.js";

const TECHNICAL_EXECUTION_FAILURE_SUMMARY =
  "The capability failed before returning a valid result.";

type CanonicalWorkerCapabilityAdapterResult = WorkerCapabilityAdapterResult &
  Readonly<{ exactResult: CapabilityAdapterResult }>;
const INVALID_EXECUTION_RESULT_SUMMARY =
  "The capability returned an invalid result.";
const OVERSIZED_EXECUTION_RESULT_SUMMARY =
  "The capability result exceeded the Runtime evidence size limit.";

export async function executeBoundWorkerCapability<TContext>(params: {
  context: TContext;
  call: RoleCallFrame;
  currentHead: RoleCallLedgerHead;
  ledger: RoleCallLedger;
  adapter: Readonly<{
    descriptor: WorkerCapabilityDescriptor;
    execute: WorkerCapabilityAdapter<TContext>["execute"];
  }>;
  intent: string;
  controls: WorkerCapabilityControls;
  diagnostic: WorkerCapabilityDiagnosticContext;
  capabilityScope: WorkerCapabilityScopeProjection<unknown>;
  dependencyResults?: readonly RoleCallDependencyResult[];
  executionFreshness?: WorkerCapabilityExecutionFreshness;
}): Promise<WorkerCapabilityExecutionReference> {
  assertExecutionCapabilityScope(
    params.capabilityScope,
    params.adapter.descriptor,
    params.diagnostic,
  );
  let settledCapabilityResults: readonly WorkerSettledCapabilityResult[];
  try {
    settledCapabilityResults = projectWorkerSettledCapabilityResults({
      ledger: params.ledger,
      head: params.currentHead,
      call: params.call,
    });
  } catch (error: unknown) {
    const issueCode = settledResultProjectionIssueCode(error);
    traceWorkerCapabilityContextRejected(
      params.diagnostic,
      params.adapter.descriptor,
      issueCode,
    );
    throw new Error(`worker_capability_context_rejected:${issueCode}`);
  }
  traceWorkerCapabilityContextProjected(
    params.diagnostic,
    params.adapter.descriptor,
    settledCapabilityResults,
  );

  const transactions = resolveRoleCallTransactions(params.ledger);
  const begunResult = await transactions.beginCapabilityExecution({
    expectedHead: params.currentHead,
    callId: params.call.callId,
    invocationAttempt: params.call.activationCount,
    capabilityId: params.adapter.descriptor.capabilityId,
    declaredEffect: params.adapter.descriptor.effect,
    intent: params.intent,
    controlsJson: JSON.stringify(params.controls),
  });
  if (!begunResult.ok) {
    traceWorkerCapabilityStateRejected(
      params.diagnostic,
      params.adapter.descriptor,
      {
        phase: "begin",
        issueCode: begunResult.issueCode,
      },
    );
    throw stateRejection("begin", begunResult.issueCode);
  }
  const begun = begunResult.commit;

  const executionId = begun.effect.executionId;
  traceWorkerCapabilityExecutionStarted(
    params.diagnostic,
    params.adapter.descriptor,
    executionId,
    params.intent.length,
    Object.keys(params.controls).length,
  );

  const result = await executeAndNormalizeAdapter({
    context: params.context,
    call: params.call,
    execute: params.adapter.execute,
    intent: params.intent,
    controls: params.controls,
    descriptor: params.adapter.descriptor,
    diagnostic: params.diagnostic,
    executionId,
    settledCapabilityResults,
    ...(params.dependencyResults
      ? { dependencyResults: params.dependencyResults }
      : {}),
    ...(params.executionFreshness
      ? { executionFreshness: params.executionFreshness }
      : {}),
  });

  const settledResult = await transactions.settleCapabilityExecution({
    expectedHead: begun.head,
    callId: params.call.callId,
    executionId,
    outcome: result.outcome,
    observedEffect: result.observedEffect,
    summary: result.summary,
    ...(result.referenceData ? { referenceData: result.referenceData } : {}),
    ...(result.references ? { references: result.references } : {}),
    exactResult: result.exactResult,
  });
  if (!settledResult.ok) {
    traceWorkerCapabilityStateRejected(
      params.diagnostic,
      params.adapter.descriptor,
      {
        phase: "settle",
        issueCode: settledResult.issueCode,
        executionId,
      },
    );
    throw stateRejection("settle", settledResult.issueCode);
  }

  traceWorkerCapabilityExecutionCompleted(
    params.diagnostic,
    params.adapter.descriptor,
    result,
    executionId,
  );
  return Object.freeze({ executionId });
}

export async function executeBoundWorkerCapabilityBatch<TContext>(params: {
  context: TContext;
  call: RoleCallFrame;
  currentHead: RoleCallLedgerHead;
  ledger: RoleCallLedger;
  invocations: readonly Readonly<{
    adapter: Readonly<{
      descriptor: WorkerCapabilityDescriptor;
      execute: WorkerCapabilityAdapter<TContext>["execute"];
    }>;
    intent: string;
    controls: WorkerCapabilityControls;
  }>[];
  diagnostic: WorkerCapabilityDiagnosticContext;
  capabilityScope: WorkerCapabilityScopeProjection<unknown>;
  dependencyResults?: readonly RoleCallDependencyResult[];
  executionFreshness?: WorkerCapabilityExecutionFreshness;
}): Promise<WorkerCapabilityBatchExecutionReference> {
  if (
    params.invocations.length < 2 ||
    params.invocations.some(
      ({ adapter }) => adapter.descriptor.effect !== "observation",
    )
  ) {
    throw new Error("worker_capability_batch_invalid");
  }
  for (const { adapter } of params.invocations) {
    assertExecutionCapabilityScope(
      params.capabilityScope,
      adapter.descriptor,
      params.diagnostic,
    );
  }

  let settledCapabilityResults: readonly WorkerSettledCapabilityResult[];
  try {
    settledCapabilityResults = projectWorkerSettledCapabilityResults({
      ledger: params.ledger,
      head: params.currentHead,
      call: params.call,
    });
  } catch (error: unknown) {
    const issueCode = settledResultProjectionIssueCode(error);
    for (const { adapter } of params.invocations) {
      traceWorkerCapabilityContextRejected(
        params.diagnostic,
        adapter.descriptor,
        issueCode,
      );
    }
    throw new Error(`worker_capability_context_rejected:${issueCode}`);
  }
  for (const { adapter } of params.invocations) {
    traceWorkerCapabilityContextProjected(
      params.diagnostic,
      adapter.descriptor,
      settledCapabilityResults,
    );
  }

  const transactions = resolveRoleCallTransactions(params.ledger);
  const begunResult = await transactions.beginCapabilityBatch({
    expectedHead: params.currentHead,
    callId: params.call.callId,
    invocationAttempt: params.call.activationCount,
    entries: params.invocations.map(({ adapter, intent, controls }) => ({
      capabilityId: adapter.descriptor.capabilityId,
      declaredEffect: "observation" as const,
      intent,
      controlsJson: JSON.stringify(controls),
    })),
  });
  if (!begunResult.ok) {
    for (const { adapter } of params.invocations) {
      traceWorkerCapabilityStateRejected(
        params.diagnostic,
        adapter.descriptor,
        { phase: "begin", issueCode: begunResult.issueCode },
      );
    }
    throw stateRejection("begin", begunResult.issueCode);
  }
  const begun = begunResult.commit;

  const executionIds = begun.effect.executionIds;
  params.invocations.forEach((invocation, index) => {
    traceWorkerCapabilityExecutionStarted(
      params.diagnostic,
      invocation.adapter.descriptor,
      executionIds[index]!,
      invocation.intent.length,
      Object.keys(invocation.controls).length,
    );
  });
  const results = await Promise.all(
    params.invocations.map((invocation, index) =>
      executeAndNormalizeAdapter({
        context: params.context,
        call: params.call,
        execute: invocation.adapter.execute,
        intent: invocation.intent,
        controls: invocation.controls,
        descriptor: invocation.adapter.descriptor,
        diagnostic: params.diagnostic,
        executionId: executionIds[index]!,
        settledCapabilityResults,
        ...(params.dependencyResults
          ? { dependencyResults: params.dependencyResults }
          : {}),
        ...(params.executionFreshness
          ? { executionFreshness: params.executionFreshness }
          : {}),
      }),
    ),
  );

  const settledResult = await transactions.settleCapabilityBatch({
    expectedHead: begun.head,
    callId: params.call.callId,
    settlements: results.map((result, index) => ({
      executionId: executionIds[index]!,
      outcome: result.outcome,
      observedEffect: result.observedEffect,
      summary: result.summary,
      ...(result.referenceData ? { referenceData: result.referenceData } : {}),
      ...(result.references ? { references: result.references } : {}),
      exactResult: result.exactResult,
    })),
  });
  if (!settledResult.ok) {
    params.invocations.forEach((invocation, index) => {
      traceWorkerCapabilityStateRejected(
        params.diagnostic,
        invocation.adapter.descriptor,
        {
          phase: "settle",
          issueCode: settledResult.issueCode,
          executionId: executionIds[index],
        },
      );
    });
    throw stateRejection("settle", settledResult.issueCode);
  }

  params.invocations.forEach((invocation, index) => {
    traceWorkerCapabilityExecutionCompleted(
      params.diagnostic,
      invocation.adapter.descriptor,
      results[index]!,
      executionIds[index]!,
    );
  });
  return Object.freeze({ executionIds: Object.freeze([...executionIds]) });
}

function assertExecutionCapabilityScope(
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

function settledResultProjectionIssueCode(error: unknown): string {
  if (
    error instanceof Error &&
    (error.message === "worker_settled_results_head_stale" ||
      error.message === "worker_settled_results_call_invalid" ||
      error.message === "worker_settled_results_execution_invalid")
  ) {
    return error.message;
  }
  return "worker_settled_results_projection_failed";
}

async function executeAndNormalizeAdapter<TContext>(params: {
  context: TContext;
  call: RoleCallFrame;
  execute: WorkerCapabilityAdapter<TContext>["execute"];
  intent: string;
  controls: WorkerCapabilityControls;
  descriptor: WorkerCapabilityDescriptor;
  diagnostic: WorkerCapabilityDiagnosticContext;
  executionId: string;
  settledCapabilityResults: readonly WorkerSettledCapabilityResult[];
  dependencyResults?: readonly RoleCallDependencyResult[];
  executionFreshness?: WorkerCapabilityExecutionFreshness;
}): Promise<CanonicalWorkerCapabilityAdapterResult> {
  let rawResult: WorkerCapabilityAdapterResult;
  try {
    rawResult = await params.execute(
      Object.freeze({
        context: params.context,
        call: params.call,
        executionId: params.executionId,
        intent: params.intent,
        controls: params.controls,
        settledCapabilityResults: params.settledCapabilityResults,
        ...(params.dependencyResults
          ? { dependencyResults: params.dependencyResults }
          : {}),
        ...(params.executionFreshness
          ? { executionFreshness: params.executionFreshness }
          : {}),
      }),
    );
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    traceWorkerCapabilityExecutionFailed(
      params.diagnostic,
      params.descriptor,
      error,
      params.executionId,
    );
    return attachCanonicalExactResult(
      technicalFailure(adapterExecutionFailureSummary(error)),
    );
  }

  let normalized: ReturnType<typeof normalizeAdapterResult>;
  try {
    normalized = normalizeAdapterResult(rawResult, params.descriptor.effect);
  } catch (error: unknown) {
    normalized = {
      ok: false,
      issueCode: exactResultNormalizationIssueCode(error),
    };
  }
  if (!normalized.ok) {
    traceWorkerCapabilityResultRejected(
      params.diagnostic,
      params.descriptor,
      normalized.issueCode,
      params.executionId,
    );
    return attachCanonicalExactResult(
      technicalFailure(
        normalized.issueCode === "adapter_result_too_large"
          ? OVERSIZED_EXECUTION_RESULT_SUMMARY
          : INVALID_EXECUTION_RESULT_SUMMARY,
      ),
    );
  }
  return normalized.value;
}

function adapterExecutionFailureSummary(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.endsWith("canonical_result_result_too_large")) {
      return OVERSIZED_EXECUTION_RESULT_SUMMARY;
    }
    if (
      error.message.endsWith("canonical_result_result_invalid") ||
      error.message.endsWith("canonical_result_result_not_json_safe")
    ) {
      return INVALID_EXECUTION_RESULT_SUMMARY;
    }
  }
  return TECHNICAL_EXECUTION_FAILURE_SUMMARY;
}

function exactResultNormalizationIssueCode(error: unknown): string {
  if (
    error instanceof Error &&
    error.message.startsWith("capability_exact_result_invalid:")
  ) {
    const code = error.message.slice("capability_exact_result_invalid:".length);
    if (
      code === "result_invalid" ||
      code === "result_not_json_safe" ||
      code === "result_too_large"
    ) {
      return `adapter_${code}`;
    }
  }
  return "adapter_result_unreadable";
}

function normalizeAdapterResult(
  input: WorkerCapabilityAdapterResult,
  declaredEffect: WorkerCapabilityEffect,
):
  | Readonly<{ ok: true; value: CanonicalWorkerCapabilityAdapterResult }>
  | Readonly<{ ok: false; issueCode: string }> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issueCode: "adapter_result_not_object" };
  }
  const keys = Object.keys(input);
  if (
    keys.length < 3 ||
    keys.length > 6 ||
    !keys.includes("outcome") ||
    !keys.includes("observedEffect") ||
    !keys.includes("summary") ||
    keys.some(
      (key) =>
        key !== "outcome" &&
        key !== "observedEffect" &&
        key !== "summary" &&
        key !== "referenceData" &&
        key !== "references" &&
        key !== "exactResult",
    )
  ) {
    return { ok: false, issueCode: "adapter_result_shape_invalid" };
  }
  if (
    typeof input.summary !== "string" ||
    input.summary.trim().length === 0 ||
    input.summary.length > ROLE_CALL_RESULT_MAX_LENGTH
  ) {
    return { ok: false, issueCode: "adapter_result_summary_invalid" };
  }
  if (
    input.referenceData !== undefined &&
    (typeof input.referenceData !== "string" ||
      input.referenceData.trim().length === 0 ||
      input.referenceData.length > ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH)
  ) {
    return { ok: false, issueCode: "adapter_result_reference_data_invalid" };
  }
  const references = normalizeResultReferences(input.references);
  if (references === null) {
    return { ok: false, issueCode: "adapter_result_references_invalid" };
  }
  if (input.outcome === "succeeded") {
    if (
      !isSuccessfulObservedEffectCompatible(
        input.observedEffect,
        declaredEffect,
      )
    ) {
      return { ok: false, issueCode: "observed_effect_mismatch" };
    }
    return {
      ok: true,
      value: attachCanonicalExactResult(
        Object.freeze({
          outcome: "succeeded",
          observedEffect: input.observedEffect,
          summary: input.summary.trim(),
          ...(input.referenceData
            ? { referenceData: input.referenceData.trim() }
            : {}),
          ...(references ? { references } : {}),
        }),
        input,
      ),
    };
  }
  if (input.outcome === "failed") {
    if (
      !isFailedObservedEffectCompatible(input.observedEffect, declaredEffect)
    ) {
      return { ok: false, issueCode: "failed_effect_invalid" };
    }
    return {
      ok: true,
      value: attachCanonicalExactResult(
        Object.freeze({
          outcome: "failed",
          observedEffect: input.observedEffect,
          summary: input.summary.trim(),
          ...(input.referenceData
            ? { referenceData: input.referenceData.trim() }
            : {}),
          ...(references ? { references } : {}),
        }),
        input,
      ),
    };
  }
  return { ok: false, issueCode: "adapter_result_outcome_invalid" };
}

function attachCanonicalExactResult(
  normalized: WorkerCapabilityAdapterResult,
  raw: WorkerCapabilityAdapterResult = normalized,
): CanonicalWorkerCapabilityAdapterResult {
  const exact =
    raw.exactResult === undefined
      ? captureLegacyCapabilityAdapterResult(raw)
      : normalizeCapabilityAdapterResult(raw.exactResult);
  if (!exact.ok) {
    throw new Error(`capability_exact_result_invalid:${exact.code}`);
  }
  return Object.freeze({
    ...normalized,
    exactResult: exact.value,
  });
}

function normalizeResultReferences(
  input: unknown,
): readonly RoleCapabilityResultReference[] | undefined | null {
  if (input === undefined) return undefined;
  if (
    !Array.isArray(input) ||
    input.length > ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX
  ) {
    return null;
  }
  const targets = new Set<string>();
  const references: RoleCapabilityResultReference[] = [];
  for (const candidate of input) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return null;
    }
    const reference = candidate as Record<string, unknown>;
    if (
      Object.keys(reference).length !== 2 ||
      reference.kind !== "tool_target" ||
      typeof reference.target !== "string" ||
      reference.target.trim().length === 0 ||
      reference.target.length >
        ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH
    ) {
      return null;
    }
    const target = reference.target.trim();
    if (targets.has(target)) return null;
    targets.add(target);
    references.push(Object.freeze({ kind: "tool_target", target }));
  }
  return Object.freeze(references);
}

function isSuccessfulObservedEffectCompatible(
  observedEffect: unknown,
  declaredEffect: WorkerCapabilityEffect,
): observedEffect is "observation" | "mutation" {
  return declaredEffect === "mixed"
    ? observedEffect === "observation" || observedEffect === "mutation"
    : observedEffect === declaredEffect;
}

function isFailedObservedEffectCompatible(
  observedEffect: unknown,
  declaredEffect: WorkerCapabilityEffect,
): boolean {
  return (
    observedEffect === "none" ||
    observedEffect === "indeterminate" ||
    observedEffect === "observation" ||
    (observedEffect === "mutation" &&
      (declaredEffect === "mutation" || declaredEffect === "mixed"))
  );
}

function technicalFailure(summary: string): WorkerCapabilityAdapterResult {
  return Object.freeze({
    outcome: "failed",
    observedEffect: "indeterminate",
    summary,
  });
}

function stateRejection(phase: "begin" | "settle", code: string): Error {
  return new Error(`worker_capability_${phase}_rejected:${code}`);
}
