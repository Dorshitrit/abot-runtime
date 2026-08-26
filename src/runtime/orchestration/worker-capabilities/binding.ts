import {
  isRoleCapabilityId,
  hasRoleCallCapabilityAuthority,
  parseRoleCallWorkerCapabilityScope,
  projectRoleCallDependencyResults,
  type RoleCallDependencyResult,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../role-calls/index.js";
import {
  WORKER_CAPABILITY_COUNT_MAX,
  WORKER_CAPABILITY_CONTROL_COUNT_MAX,
  WORKER_CAPABILITY_CONTROL_ID_MAX_LENGTH,
  WORKER_CAPABILITY_INTENT_MAX_LENGTH,
  WORKER_CAPABILITY_SUMMARY_MAX_LENGTH,
  type WorkerCapabilityAdapter,
  type WorkerCapabilityBinding,
  type WorkerCapabilityControls,
  type WorkerCapabilityDescriptor,
  type WorkerCapabilityEffect,
  type WorkerCapabilityExecutionFreshness,
} from "./contracts.js";
import {
  normalizeWorkerCapabilityControlsSchema,
  validateWorkerCapabilityControls,
} from "./controls.js";
import { partitionWorkerCapabilityControlsSchema } from "./selection-controls.js";
import {
  traceWorkerCapabilityBindingCreated,
  traceWorkerCapabilityBindingRejected,
  traceWorkerCapabilitySelectionRejected,
  traceWorkerCapabilitySelectionResolved,
  type WorkerCapabilityDiagnosticContext,
} from "./diagnostics.js";
import {
  executeBoundWorkerCapability,
  executeBoundWorkerCapabilityBatch,
} from "./execution.js";
import { classifyRuntimeErrorType } from "../../observability/error-type.js";
import { isToolCatalogGroupId } from "../../../capabilities/tool-types.js";
import {
  projectWorkerCapabilityCatalogGroups,
  projectWorkerCapabilityScope,
  WorkerCapabilityScopeError,
  type WorkerCapabilityScopeProjection,
} from "./scope.js";

type BoundAdapter<TContext> = Readonly<{
  descriptor: WorkerCapabilityDescriptor;
  execute: WorkerCapabilityAdapter<TContext>["execute"];
}>;

type LiveCapabilityCall = Readonly<{
  currentHead: RoleCallLedgerHead;
  currentCall: RoleCallFrame;
}>;

type PreparedCapabilityInvocation<TContext> = Readonly<{
  adapter: BoundAdapter<TContext>;
  intent: string;
  controls: WorkerCapabilityControls;
}>;

type CapabilityLookupIssueCodes = Readonly<{
  invalid: string;
  outOfScope: string;
  unavailable: string;
}>;

const SINGLE_CAPABILITY_LOOKUP_ISSUES: CapabilityLookupIssueCodes =
  Object.freeze({
    invalid: "capability_id_invalid",
    outOfScope: "capability_out_of_scope",
    unavailable: "capability_unavailable",
  });

const BATCH_CAPABILITY_LOOKUP_ISSUES: CapabilityLookupIssueCodes =
  Object.freeze({
    invalid: "batch_capability_id_invalid",
    outOfScope: "batch_capability_out_of_scope",
    unavailable: "batch_capability_unavailable",
  });

export function createRoleCapabilityBinding<TContext>(params: {
  requestId: string;
  context: TContext;
  call: RoleCallFrame;
  ledger: RoleCallLedger;
  adapters: readonly WorkerCapabilityAdapter<TContext>[];
  dependencyResults?: readonly RoleCallDependencyResult[];
  executionFreshness?: WorkerCapabilityExecutionFreshness;
}): WorkerCapabilityBinding<TContext> {
  const boundCall = copyCall(params.call);
  const diagnosticScope = parseRoleCallWorkerCapabilityScope(
    boundCall.workerCapabilityScope,
  );
  const emptyDiagnostic: WorkerCapabilityDiagnosticContext = {
    requestId: params.requestId,
    call: boundCall,
    capabilityIds: Object.freeze([]),
    scopeMode:
      boundCall.workerCapabilityScope === undefined ? "full" : "catalog_groups",
    scopeCatalogGroupIds: diagnosticScope?.catalogGroupIds ?? Object.freeze([]),
    knownCatalogGroupCount: 0,
    fullCapabilityCount: 0,
    filteredCapabilityCount: 0,
  };
  const executionFreshness =
    boundCall.parentCallId === null
      ? normalizeExecutionFreshness(params.executionFreshness)
      : undefined;
  if (params.executionFreshness !== undefined && !executionFreshness) {
    traceWorkerCapabilityBindingRejected(
      emptyDiagnostic,
      "execution_freshness_invalid",
    );
    throw rejection("execution_freshness_invalid");
  }
  let initialHead: ReturnType<RoleCallLedger["current"]>;
  try {
    initialHead = params.ledger.current();
  } catch {
    traceWorkerCapabilityBindingRejected(
      emptyDiagnostic,
      "current_call_read_failed",
    );
    throw rejection("current_call_read_failed");
  }
  const authoritativeCall = initialHead.state.calls.find(
    (call) => call.callId === boundCall.callId,
  );
  const authorityIssue =
    initialHead.state.requestId !== params.requestId
      ? "request_id_mismatch"
      : initialHead.state.activeCallId !== boundCall.callId
        ? "call_not_current"
        : authoritativeCall
          ? validateExecutionCall(boundCall, authoritativeCall, initialHead)
          : "current_call_unavailable";
  if (authorityIssue) {
    traceWorkerCapabilityBindingRejected(emptyDiagnostic, authorityIssue);
    throw rejection(authorityIssue);
  }
  let dependencyResults: readonly RoleCallDependencyResult[];
  try {
    dependencyResults = bindDependencyResults(
      initialHead,
      authoritativeCall!,
      params.dependencyResults,
    );
  } catch {
    traceWorkerCapabilityBindingRejected(
      emptyDiagnostic,
      "dependency_results_invalid",
    );
    throw rejection("dependency_results_invalid");
  }
  if (
    !Array.isArray(params.adapters) ||
    params.adapters.length > WORKER_CAPABILITY_COUNT_MAX
  ) {
    traceWorkerCapabilityBindingRejected(
      emptyDiagnostic,
      "capability_count_invalid",
    );
    throw rejection("capability_count_invalid");
  }

  const boundAdapters: BoundAdapter<TContext>[] = [];
  const seenCapabilityIds = new Set<string>();
  for (const adapter of params.adapters) {
    const normalized = normalizeAdapter(adapter);
    if (!normalized.ok) {
      traceWorkerCapabilityBindingRejected(
        {
          ...emptyDiagnostic,
          capabilityIds: Object.freeze([...seenCapabilityIds]),
        },
        normalized.issueCode,
      );
      throw rejection(normalized.issueCode);
    }
    if (seenCapabilityIds.has(normalized.value.descriptor.capabilityId)) {
      traceWorkerCapabilityBindingRejected(
        {
          ...emptyDiagnostic,
          capabilityIds: Object.freeze([...seenCapabilityIds]),
        },
        "duplicate_capability_id",
      );
      throw rejection("duplicate_capability_id");
    }
    seenCapabilityIds.add(normalized.value.descriptor.capabilityId);
    boundAdapters.push(normalized.value);
  }

  const knownCatalogGroups = projectWorkerCapabilityCatalogGroups(
    boundAdapters.map((adapter) => adapter.descriptor),
  );
  let capabilityScope: WorkerCapabilityScopeProjection<BoundAdapter<TContext>>;
  try {
    capabilityScope = projectWorkerCapabilityScope({
      entries: boundAdapters,
      scope: boundCall.workerCapabilityScope,
      descriptorOf: (adapter) => adapter.descriptor,
    });
  } catch (error: unknown) {
    const issueCode =
      error instanceof WorkerCapabilityScopeError
        ? error.issueCode
        : "capability_scope_projection_invalid";
    traceWorkerCapabilityBindingRejected(
      {
        ...emptyDiagnostic,
        capabilityIds: Object.freeze([...seenCapabilityIds]),
        knownCatalogGroupCount: knownCatalogGroups.length,
        fullCapabilityCount: boundAdapters.length,
      },
      issueCode,
    );
    throw rejection(issueCode);
  }

  const scopedAdapters = capabilityScope.entries;
  const byCapabilityId = new Map(
    scopedAdapters.map((adapter) => [adapter.descriptor.capabilityId, adapter]),
  );
  const capabilities = Object.freeze(
    scopedAdapters.map((adapter) => adapter.descriptor),
  );
  const diagnostic: WorkerCapabilityDiagnosticContext = Object.freeze({
    requestId: params.requestId,
    call: boundCall,
    capabilityIds: capabilityScope.filteredCapabilityIds,
    scopeMode: capabilityScope.mode,
    scopeCatalogGroupIds: capabilityScope.catalogGroupIds,
    knownCatalogGroupCount: capabilityScope.knownCatalogGroupIds.length,
    fullCapabilityCount: capabilityScope.fullCapabilityIds.length,
    filteredCapabilityCount: capabilityScope.filteredCapabilityIds.length,
  });
  traceWorkerCapabilityBindingCreated(diagnostic);

  const session = new BoundCapabilitySession({
    requestId: params.requestId,
    context: params.context,
    boundCall,
    ledger: params.ledger,
    capabilities,
    byCapabilityId,
    diagnostic,
    capabilityScope,
    dependencyResults,
    ...(executionFreshness ? { executionFreshness } : {}),
  });
  return session.toBinding();
}

/**
 * Immutable request/call-scoped capability facade. Authoritative ledger state
 * is deliberately resolved per invocation and is never stored on the session.
 */
class BoundCapabilitySession<TContext> {
  readonly #requestId: string;
  readonly #context: TContext;
  readonly #boundCall: RoleCallFrame;
  readonly #ledger: RoleCallLedger;
  readonly #capabilities: readonly WorkerCapabilityDescriptor[];
  readonly #byCapabilityId: ReadonlyMap<string, BoundAdapter<TContext>>;
  readonly #diagnostic: WorkerCapabilityDiagnosticContext;
  readonly #capabilityScope: WorkerCapabilityScopeProjection<
    BoundAdapter<TContext>
  >;
  readonly #executionFreshness?: WorkerCapabilityExecutionFreshness;
  readonly #dependencyResults: readonly RoleCallDependencyResult[];

  constructor(params: {
    requestId: string;
    context: TContext;
    boundCall: RoleCallFrame;
    ledger: RoleCallLedger;
    capabilities: readonly WorkerCapabilityDescriptor[];
    byCapabilityId: ReadonlyMap<string, BoundAdapter<TContext>>;
    diagnostic: WorkerCapabilityDiagnosticContext;
    capabilityScope: WorkerCapabilityScopeProjection<BoundAdapter<TContext>>;
    dependencyResults: readonly RoleCallDependencyResult[];
    executionFreshness?: WorkerCapabilityExecutionFreshness;
  }) {
    this.#requestId = params.requestId;
    this.#context = params.context;
    this.#boundCall = params.boundCall;
    this.#ledger = params.ledger;
    this.#capabilities = params.capabilities;
    this.#byCapabilityId = params.byCapabilityId;
    this.#diagnostic = params.diagnostic;
    this.#capabilityScope = params.capabilityScope;
    this.#dependencyResults = params.dependencyResults;
    this.#executionFreshness = params.executionFreshness;
  }

  toBinding(): WorkerCapabilityBinding<TContext> {
    return Object.freeze({
      requestId: this.#requestId,
      ledger: this.#ledger,
      callId: this.#boundCall.callId,
      invocationAttempt: this.#boundCall.activationCount,
      capabilities: this.#capabilities,
      execute: async (input) => this.#execute(input),
      executeBatch: async (input) => this.#executeBatch(input),
    });
  }

  async #execute(
    input: Parameters<WorkerCapabilityBinding<TContext>["execute"]>[0],
  ) {
    const { currentHead, currentCall } = this.#resolveLiveCall({
      ...(isValidCapabilityId(input.capabilityId)
        ? { attemptedCapabilityId: input.capabilityId }
        : {}),
    });
    const invocation = this.#prepareSingleInvocation(input);

    return executeBoundWorkerCapability({
      context: this.#context,
      call: currentCall,
      currentHead,
      ledger: this.#ledger,
      ...invocation,
      diagnostic: this.#diagnostic,
      capabilityScope: this.#capabilityScope,
      ...(this.#dependencyResults.length > 0
        ? { dependencyResults: this.#dependencyResults }
        : {}),
      ...(this.#executionFreshness
        ? { executionFreshness: this.#executionFreshness }
        : {}),
    });
  }

  async #executeBatch(
    input: Parameters<WorkerCapabilityBinding<TContext>["executeBatch"]>[0],
  ) {
    const { currentHead, currentCall } = this.#resolveLiveCall();
    if (!Array.isArray(input.invocations) || input.invocations.length < 2) {
      traceWorkerCapabilitySelectionRejected(this.#diagnostic, {
        issueCode: "batch_size_invalid",
      });
      throw rejection("batch_size_invalid");
    }
    if (
      currentHead.state.capabilityExecutions.length + input.invocations.length >
      currentHead.policy.limits.maxCapabilityExecutions
    ) {
      traceWorkerCapabilitySelectionRejected(this.#diagnostic, {
        issueCode: "capability_execution_limit_exceeded",
      });
      throw rejection("capability_execution_limit_exceeded");
    }

    const invocations = this.#prepareBatchInvocations(input.invocations);
    return executeBoundWorkerCapabilityBatch({
      context: this.#context,
      call: currentCall,
      currentHead,
      ledger: this.#ledger,
      invocations,
      diagnostic: this.#diagnostic,
      capabilityScope: this.#capabilityScope,
      ...(this.#dependencyResults.length > 0
        ? { dependencyResults: this.#dependencyResults }
        : {}),
      ...(this.#executionFreshness
        ? { executionFreshness: this.#executionFreshness }
        : {}),
    });
  }

  #resolveLiveCall(
    params: Readonly<{ attemptedCapabilityId?: string }> = {},
  ): LiveCapabilityCall {
    let currentHead: RoleCallLedgerHead;
    let currentCall: RoleCallFrame | undefined;
    try {
      currentHead = this.#ledger.current();
      if (currentHead.state.requestId !== this.#requestId) {
        traceWorkerCapabilitySelectionRejected(this.#diagnostic, {
          issueCode: "request_id_mismatch",
        });
        throw rejection("request_id_mismatch");
      }
      if (currentHead.state.activeCallId !== this.#boundCall.callId) {
        traceWorkerCapabilitySelectionRejected(this.#diagnostic, {
          issueCode: "call_not_current",
        });
        throw rejection("call_not_current");
      }
      currentCall = currentHead.state.calls.find(
        (call) => call.callId === this.#boundCall.callId,
      );
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message.startsWith("worker_capability_rejected:")
      ) {
        throw error;
      }
      traceWorkerCapabilitySelectionRejected(this.#diagnostic, {
        issueCode: "current_call_read_failed",
        errorType: classifyRuntimeErrorType(error),
      });
      throw rejection("current_call_read_failed");
    }
    if (!currentCall) {
      traceWorkerCapabilitySelectionRejected(this.#diagnostic, {
        issueCode: "current_call_unavailable",
      });
      throw rejection("current_call_unavailable");
    }
    const bindingIssue = validateExecutionCall(
      this.#boundCall,
      currentCall,
      currentHead,
    );
    if (bindingIssue) {
      traceWorkerCapabilitySelectionRejected(this.#diagnostic, {
        issueCode: bindingIssue,
        attemptedCallId: currentCall.callId,
        attemptedInvocationAttempt: currentCall.activationCount,
        ...(params.attemptedCapabilityId
          ? { capabilityId: params.attemptedCapabilityId }
          : {}),
      });
      throw rejection(bindingIssue);
    }
    return { currentHead, currentCall };
  }

  #prepareSingleInvocation(
    input: Parameters<WorkerCapabilityBinding<TContext>["execute"]>[0],
  ): PreparedCapabilityInvocation<TContext> {
    const adapter = this.#resolveAvailableAdapter(
      input.capabilityId,
      SINGLE_CAPABILITY_LOOKUP_ISSUES,
    );
    const intent = normalizeIntent(input.intent);
    if (!intent.ok) {
      traceWorkerCapabilitySelectionRejected(this.#diagnostic, {
        issueCode: intent.issueCode,
        capabilityId: input.capabilityId,
      });
      throw rejection(intent.issueCode);
    }
    const controls = validateWorkerCapabilityControls(
      adapter.descriptor.controls,
      input.controls,
    );
    if (!controls.ok) {
      traceWorkerCapabilitySelectionRejected(this.#diagnostic, {
        issueCode: controls.issueCode,
        capabilityId: input.capabilityId,
      });
      throw rejection(controls.issueCode);
    }
    this.#traceSelectionResolved(adapter, intent.value, controls.value);
    return {
      adapter,
      intent: intent.value,
      controls: controls.value,
    };
  }

  #prepareBatchInvocations(
    candidates: Parameters<
      WorkerCapabilityBinding<TContext>["executeBatch"]
    >[0]["invocations"],
  ): readonly PreparedCapabilityInvocation<TContext>[] {
    const invocations: PreparedCapabilityInvocation<TContext>[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      const adapter = this.#resolveAvailableAdapter(
        candidate.capabilityId,
        BATCH_CAPABILITY_LOOKUP_ISSUES,
      );
      if (adapter.descriptor.effect !== "observation") {
        traceWorkerCapabilitySelectionRejected(this.#diagnostic, {
          issueCode: "batch_effect_invalid",
          capabilityId: candidate.capabilityId,
        });
        throw rejection("batch_effect_invalid");
      }
      const intent = normalizeIntent(candidate.intent);
      if (!intent.ok) {
        const issueCode = `batch_${intent.issueCode}`;
        traceWorkerCapabilitySelectionRejected(this.#diagnostic, {
          issueCode,
          capabilityId: candidate.capabilityId,
        });
        throw rejection(issueCode);
      }
      const controls = validateWorkerCapabilityControls(
        adapter.descriptor.controls,
        candidate.controls,
      );
      if (!controls.ok) {
        const issueCode = `batch_${controls.issueCode}`;
        traceWorkerCapabilitySelectionRejected(this.#diagnostic, {
          issueCode,
          capabilityId: candidate.capabilityId,
        });
        throw rejection(issueCode);
      }
      this.#traceSelectionResolved(adapter, intent.value, controls.value);
      invocations.push({
        adapter,
        intent: intent.value,
        controls: controls.value,
      });
    }
    return Object.freeze(invocations);
  }

  #resolveAvailableAdapter(
    capabilityId: unknown,
    issueCodes: CapabilityLookupIssueCodes,
  ): BoundAdapter<TContext> {
    if (!isValidCapabilityId(capabilityId)) {
      traceWorkerCapabilitySelectionRejected(this.#diagnostic, {
        issueCode: issueCodes.invalid,
      });
      throw rejection(issueCodes.invalid);
    }
    const adapter = this.#byCapabilityId.get(capabilityId);
    if (!adapter) {
      const issueCode = this.#capabilityScope.fullCapabilityIds.includes(
        capabilityId,
      )
        ? issueCodes.outOfScope
        : issueCodes.unavailable;
      traceWorkerCapabilitySelectionRejected(this.#diagnostic, {
        issueCode,
        capabilityId,
      });
      throw rejection(issueCode);
    }
    return adapter;
  }

  #traceSelectionResolved(
    adapter: BoundAdapter<TContext>,
    intent: string,
    controls: WorkerCapabilityControls,
  ): void {
    traceWorkerCapabilitySelectionResolved(
      this.#diagnostic,
      adapter.descriptor,
      intent.length,
      Object.keys(controls).length,
    );
  }
}

function normalizeExecutionFreshness(
  input: WorkerCapabilityExecutionFreshness | undefined,
): WorkerCapabilityExecutionFreshness | undefined {
  if (input === undefined) return undefined;
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.isCurrent !== "function" ||
    typeof input.token !== "object" ||
    input.token === null ||
    input.token.kind !== "request_steering_v1" ||
    !Number.isSafeInteger(input.token.version) ||
    input.token.version < 0 ||
    !Array.isArray(input.token.updates) ||
    input.token.updates.length !== input.token.version ||
    input.token.updates.some(
      (update, index) =>
        typeof update !== "object" ||
        update === null ||
        update.sequence !== index + 1 ||
        typeof update.text !== "string" ||
        update.text.trim().length === 0,
    )
  ) {
    return undefined;
  }
  const source = input;
  return Object.freeze({
    token: Object.freeze({
      kind: "request_steering_v1" as const,
      version: input.token.version,
      updates: Object.freeze(
        input.token.updates.map(({ sequence, text }) =>
          Object.freeze({ sequence, text }),
        ),
      ),
    }),
    isCurrent: () => source.isCurrent(),
  });
}

function validateActiveRoleCapabilityCall(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): string | null {
  if (
    call.status !== "active" ||
    !Number.isInteger(call.activationCount) ||
    call.activationCount < 1 ||
    call.resultRef !== null ||
    !hasRoleCallCapabilityAuthority(
      head.policy.authority,
      head.state.rootCallId,
      call,
    )
  ) {
    return "worker_call_invalid";
  }
  const isRoot =
    call.callId === head.state.rootCallId && call.parentCallId === null;
  if (
    (isRoot && (call.depth !== 0 || call.objective !== null)) ||
    (!isRoot &&
      (call.parentCallId === null ||
        call.depth < 1 ||
        call.objective === null ||
        call.objective.trim().length === 0))
  ) {
    return "worker_call_invalid";
  }
  return null;
}

function validateExecutionCall(
  boundCall: RoleCallFrame,
  currentCall: RoleCallFrame,
  head: RoleCallLedgerHead,
): string | null {
  const activeIssue = validateActiveRoleCapabilityCall(head, currentCall);
  if (activeIssue) return activeIssue;
  if (currentCall.callId !== boundCall.callId) return "call_id_mismatch";
  if (currentCall.roleId !== boundCall.roleId) return "worker_call_invalid";
  if (currentCall.parentCallId !== boundCall.parentCallId) {
    return "parent_call_id_mismatch";
  }
  if (currentCall.depth !== boundCall.depth) return "call_depth_mismatch";
  if (currentCall.activationCount !== boundCall.activationCount) {
    return "invocation_attempt_mismatch";
  }
  if (currentCall.workingDirectory !== boundCall.workingDirectory) {
    return "working_directory_mismatch";
  }
  if (
    !sameWorkerCapabilityScope(
      currentCall.workerCapabilityScope,
      boundCall.workerCapabilityScope,
    )
  ) {
    return "worker_capability_scope_mismatch";
  }
  return null;
}

/** Compatibility name for the existing Worker contract and focused callers. */
export const createWorkerCapabilityBinding = createRoleCapabilityBinding;

function bindDependencyResults(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
  supplied: readonly RoleCallDependencyResult[] | undefined,
): readonly RoleCallDependencyResult[] {
  const canonical = projectRoleCallDependencyResults(head, call);
  if (supplied === undefined) return canonical;
  if (
    !Array.isArray(supplied) ||
    !Object.isFrozen(supplied) ||
    supplied.length !== canonical.length ||
    supplied.some((result, index) => {
      const expected = canonical[index];
      return (
        !Object.isFrozen(result) ||
        !expected ||
        result.resultRef !== expected.resultRef ||
        result.producerCallId !== expected.producerCallId ||
        result.roleId !== expected.roleId ||
        result.outcome !== expected.outcome ||
        result.summary !== expected.summary
      );
    })
  ) {
    throw new Error("worker_dependency_results_invalid");
  }
  return Object.freeze([...supplied]);
}

function sameWorkerCapabilityScope(
  left: RoleCallFrame["workerCapabilityScope"],
  right: RoleCallFrame["workerCapabilityScope"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.catalogGroupIds.length === right.catalogGroupIds.length &&
    left.catalogGroupIds.every(
      (groupId, index) => groupId === right.catalogGroupIds[index],
    )
  );
}

function normalizeAdapter<TContext>(
  adapter: WorkerCapabilityAdapter<TContext>,
):
  | Readonly<{ ok: true; value: BoundAdapter<TContext> }>
  | Readonly<{ ok: false; issueCode: string }> {
  if (
    typeof adapter !== "object" ||
    adapter === null ||
    Array.isArray(adapter)
  ) {
    return { ok: false, issueCode: "adapter_invalid" };
  }
  const descriptor = normalizeDescriptor(adapter.descriptor);
  if (!descriptor.ok) return descriptor;
  if (typeof adapter.execute !== "function") {
    return { ok: false, issueCode: "adapter_execute_missing" };
  }
  return {
    ok: true,
    value: Object.freeze({
      descriptor: descriptor.value,
      execute: adapter.execute,
    }),
  };
}

function normalizeDescriptor(
  descriptor: WorkerCapabilityDescriptor,
):
  | Readonly<{ ok: true; value: WorkerCapabilityDescriptor }>
  | Readonly<{ ok: false; issueCode: string }> {
  if (
    typeof descriptor !== "object" ||
    descriptor === null ||
    Array.isArray(descriptor)
  ) {
    return { ok: false, issueCode: "descriptor_invalid" };
  }
  if (!isValidCapabilityId(descriptor.capabilityId)) {
    return { ok: false, issueCode: "descriptor_capability_id_invalid" };
  }
  if (
    typeof descriptor.summary !== "string" ||
    descriptor.summary.trim().length === 0 ||
    descriptor.summary.length > WORKER_CAPABILITY_SUMMARY_MAX_LENGTH
  ) {
    return { ok: false, issueCode: "descriptor_summary_invalid" };
  }
  if (!isWorkerCapabilityEffect(descriptor.effect)) {
    return { ok: false, issueCode: "descriptor_effect_invalid" };
  }
  const controls = normalizeWorkerCapabilityControlsSchema(descriptor.controls);
  if (!controls.ok) {
    return {
      ok: false,
      issueCode: `descriptor_${controls.issueCode}`,
    };
  }
  const runtimePathControlIds = normalizeRuntimePathControlIds(
    controls.value,
    descriptor.runtimePathControlIds,
  );
  if (!runtimePathControlIds.ok) {
    return {
      ok: false,
      issueCode: `descriptor_${runtimePathControlIds.issueCode}`,
    };
  }
  const controlsPartition = partitionWorkerCapabilityControlsSchema(
    controls.value,
    descriptor.selectionControlIds,
  );
  if (!controlsPartition.ok) {
    return {
      ok: false,
      issueCode: `descriptor_${controlsPartition.issueCode}`,
    };
  }
  if (
    descriptor.controlsRefinement !== undefined &&
    descriptor.controlsRefinement !== "mechanical_when_complete"
  ) {
    return { ok: false, issueCode: "descriptor_controls_refinement_invalid" };
  }
  const catalogGroups = descriptor.catalogGroups ?? ["other"];
  if (
    !Array.isArray(catalogGroups) ||
    catalogGroups.length === 0 ||
    new Set(catalogGroups).size !== catalogGroups.length ||
    catalogGroups.some((catalogGroup) => !isToolCatalogGroupId(catalogGroup))
  ) {
    return { ok: false, issueCode: "descriptor_catalog_groups_invalid" };
  }
  return {
    ok: true,
    value: Object.freeze({
      capabilityId: descriptor.capabilityId,
      summary: descriptor.summary.trim(),
      effect: descriptor.effect,
      controls: controls.value,
      ...(runtimePathControlIds.value.length > 0
        ? { runtimePathControlIds: runtimePathControlIds.value }
        : {}),
      ...(controlsPartition.value.selectionControlIds.length > 0
        ? {
            selectionControlIds: controlsPartition.value.selectionControlIds,
          }
        : {}),
      ...(descriptor.controlsRefinement
        ? { controlsRefinement: descriptor.controlsRefinement }
        : {}),
      catalogGroups: Object.freeze([...catalogGroups]),
    }),
  };
}

function normalizeRuntimePathControlIds(
  controls: WorkerCapabilityDescriptor["controls"],
  input: readonly string[] | undefined,
):
  | Readonly<{ ok: true; value: readonly string[] }>
  | Readonly<{ ok: false; issueCode: string }> {
  if (input === undefined) {
    return { ok: true, value: Object.freeze([]) };
  }
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > WORKER_CAPABILITY_CONTROL_COUNT_MAX
  ) {
    return { ok: false, issueCode: "runtime_path_control_ids_invalid" };
  }
  const seen = new Set<string>();
  for (const controlId of input) {
    if (
      typeof controlId !== "string" ||
      controlId.length === 0 ||
      controlId.length > WORKER_CAPABILITY_CONTROL_ID_MAX_LENGTH ||
      controlId.trim() !== controlId
    ) {
      return { ok: false, issueCode: "runtime_path_control_ids_invalid" };
    }
    if (seen.has(controlId)) {
      return { ok: false, issueCode: "runtime_path_control_ids_duplicate" };
    }
    if (!Object.hasOwn(controls.properties, controlId)) {
      return { ok: false, issueCode: "runtime_path_control_unknown" };
    }
    seen.add(controlId);
  }
  return { ok: true, value: Object.freeze([...input]) };
}

function normalizeIntent(
  input: unknown,
):
  | Readonly<{ ok: true; value: string }>
  | Readonly<{ ok: false; issueCode: string }> {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.length > WORKER_CAPABILITY_INTENT_MAX_LENGTH
  ) {
    return { ok: false, issueCode: "intent_invalid" };
  }
  return { ok: true, value: input.trim() };
}

function isValidCapabilityId(input: unknown): input is string {
  return isRoleCapabilityId(input);
}

function isWorkerCapabilityEffect(
  input: unknown,
): input is WorkerCapabilityEffect {
  return input === "observation" || input === "mutation" || input === "mixed";
}

function rejection(issueCode: string): Error {
  return new Error(`worker_capability_rejected:${issueCode}`);
}

function copyCall(call: RoleCallFrame): RoleCallFrame {
  return Object.freeze({
    ...call,
    childCallIds: Object.freeze([...call.childCallIds]),
    ...(call.workerCapabilityScope
      ? {
          workerCapabilityScope: Object.freeze({
            catalogGroupIds: Object.freeze([
              ...call.workerCapabilityScope.catalogGroupIds,
            ]),
          }),
        }
      : {}),
  });
}
