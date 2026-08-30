import {
  isRoleCapabilityId,
  type RoleCallFrame,
} from "../../role-calls/index.js";
import {
  WORKER_CAPABILITY_AUTHORING_OBJECTIVE_MAX_LENGTH,
  WORKER_CAPABILITY_INTENT_MAX_LENGTH,
  type WorkerCapabilityAdapter,
  type WorkerCapabilityBinding,
  type WorkerCapabilityControls,
  type WorkerCapabilityDescriptor,
} from "../contracts.js";
import { validateWorkerCapabilityControls } from "../controls.js";
import {
  traceWorkerCapabilitySelectionRejected,
  traceWorkerCapabilitySelectionResolved,
  type WorkerCapabilityDiagnosticContext,
} from "../diagnostics.js";
import type { WorkerCapabilityScopeProjection } from "../scope.js";
import { workerCapabilityBindingRejection } from "./binding-rejection.js";

export type PreparedCapabilityInvocation<TContext> = Readonly<{
  adapter: WorkerCapabilityAdapter<TContext>;
  intent: string;
  authoringObjective?: string;
  controls: WorkerCapabilityControls;
}>;

type CapabilityLookupIssueCodes = Readonly<{
  invalid: string;
  outOfScope: string;
  unavailable: string;
}>;

type NormalizedText =
  | Readonly<{ ok: true; value: string }>
  | Readonly<{ ok: false; issueCode: string }>;

type NormalizedAuthoringObjective =
  | Readonly<{ ok: true; value?: string }>
  | Readonly<{ ok: false; issueCode: string }>;

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

export class CapabilityInvocationPreparer<TContext> {
  readonly #byCapabilityId: ReadonlyMap<
    string,
    WorkerCapabilityAdapter<TContext>
  >;
  readonly #capabilityScope: WorkerCapabilityScopeProjection<
    WorkerCapabilityAdapter<TContext>
  >;
  readonly #diagnostic: WorkerCapabilityDiagnosticContext;
  readonly #workerPrincipal: boolean;

  constructor(params: {
    boundCall: RoleCallFrame;
    byCapabilityId: ReadonlyMap<string, WorkerCapabilityAdapter<TContext>>;
    capabilityScope: WorkerCapabilityScopeProjection<
      WorkerCapabilityAdapter<TContext>
    >;
    diagnostic: WorkerCapabilityDiagnosticContext;
  }) {
    this.#byCapabilityId = params.byCapabilityId;
    this.#capabilityScope = params.capabilityScope;
    this.#diagnostic = params.diagnostic;
    this.#workerPrincipal =
      params.boundCall.roleId === "worker" &&
      params.boundCall.parentCallId !== null;
  }

  prepareSingle(
    input: Parameters<WorkerCapabilityBinding<TContext>["execute"]>[0],
  ): PreparedCapabilityInvocation<TContext> {
    const adapter = this.#resolveAvailableAdapter(
      input.capabilityId,
      SINGLE_CAPABILITY_LOOKUP_ISSUES,
    );
    const intent = normalizeCapabilityIntent(input.intent);
    if (!intent.ok) {
      this.#rejectSelection(intent.issueCode, input.capabilityId);
    }
    const controls = validateWorkerCapabilityControls(
      adapter.descriptor.controls,
      input.controls,
    );
    if (!controls.ok) {
      this.#rejectSelection(controls.issueCode, input.capabilityId);
    }
    const authoringObjective = normalizeAuthoringObjective({
      input,
      descriptor: adapter.descriptor,
      workerPrincipal: this.#workerPrincipal,
    });
    if (!authoringObjective.ok) {
      this.#rejectSelection(authoringObjective.issueCode, input.capabilityId);
    }
    this.#traceSelectionResolved(adapter, intent.value, controls.value);
    return createPreparedInvocation({
      adapter,
      intent: intent.value,
      authoringObjective: authoringObjective.value,
      controls: controls.value,
    });
  }

  prepareBatch(
    candidates: Parameters<
      WorkerCapabilityBinding<TContext>["executeBatch"]
    >[0]["invocations"],
  ): readonly PreparedCapabilityInvocation<TContext>[] {
    if (!hasValidCapabilityBatchCardinality(candidates)) {
      this.#rejectSelection("batch_size_invalid");
    }
    const invocations: PreparedCapabilityInvocation<TContext>[] = [];
    for (const candidate of candidates) {
      invocations.push(this.#prepareBatchCandidate(candidate));
    }
    return Object.freeze(invocations);
  }

  #prepareBatchCandidate(
    candidate: Parameters<
      WorkerCapabilityBinding<TContext>["executeBatch"]
    >[0]["invocations"][number],
  ): PreparedCapabilityInvocation<TContext> {
    const adapter = this.#resolveAvailableAdapter(
      candidate.capabilityId,
      BATCH_CAPABILITY_LOOKUP_ISSUES,
    );
    if (adapter.descriptor.effect !== "observation") {
      this.#rejectSelection("batch_effect_invalid", candidate.capabilityId);
    }
    const intent = normalizeCapabilityIntent(candidate.intent);
    if (!intent.ok) {
      this.#rejectSelection(
        `batch_${intent.issueCode}`,
        candidate.capabilityId,
      );
    }
    const controls = validateWorkerCapabilityControls(
      adapter.descriptor.controls,
      candidate.controls,
    );
    if (!controls.ok) {
      this.#rejectSelection(
        `batch_${controls.issueCode}`,
        candidate.capabilityId,
      );
    }
    const authoringObjective = normalizeAuthoringObjective({
      input: candidate,
      descriptor: adapter.descriptor,
      workerPrincipal: this.#workerPrincipal,
    });
    if (!authoringObjective.ok) {
      this.#rejectSelection(
        `batch_${authoringObjective.issueCode}`,
        candidate.capabilityId,
      );
    }
    this.#traceSelectionResolved(adapter, intent.value, controls.value);
    return createPreparedInvocation({
      adapter,
      intent: intent.value,
      authoringObjective: authoringObjective.value,
      controls: controls.value,
    });
  }

  #resolveAvailableAdapter(
    capabilityId: unknown,
    issueCodes: CapabilityLookupIssueCodes,
  ): WorkerCapabilityAdapter<TContext> {
    if (!isRoleCapabilityId(capabilityId)) {
      this.#rejectSelection(issueCodes.invalid);
    }
    const adapter = this.#byCapabilityId.get(capabilityId);
    if (adapter) return adapter;
    const isKnownButOutOfScope =
      this.#capabilityScope.fullCapabilityIds.includes(capabilityId);
    const issueCode = isKnownButOutOfScope
      ? issueCodes.outOfScope
      : issueCodes.unavailable;
    this.#rejectSelection(issueCode, capabilityId);
  }

  #traceSelectionResolved(
    adapter: WorkerCapabilityAdapter<TContext>,
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

  #rejectSelection(issueCode: string, capabilityId?: string): never {
    traceWorkerCapabilitySelectionRejected(this.#diagnostic, {
      issueCode,
      ...(capabilityId ? { capabilityId } : {}),
    });
    throw workerCapabilityBindingRejection(issueCode);
  }
}

function createPreparedInvocation<TContext>(params: {
  adapter: WorkerCapabilityAdapter<TContext>;
  intent: string;
  authoringObjective?: string;
  controls: WorkerCapabilityControls;
}): PreparedCapabilityInvocation<TContext> {
  return {
    adapter: params.adapter,
    intent: params.intent,
    ...(params.authoringObjective
      ? { authoringObjective: params.authoringObjective }
      : {}),
    controls: params.controls,
  };
}

function normalizeCapabilityIntent(input: unknown): NormalizedText {
  if (typeof input !== "string") {
    return { ok: false, issueCode: "intent_invalid" };
  }
  if (input.trim().length === 0) {
    return { ok: false, issueCode: "intent_invalid" };
  }
  if (input.length > WORKER_CAPABILITY_INTENT_MAX_LENGTH) {
    return { ok: false, issueCode: "intent_invalid" };
  }
  return { ok: true, value: input.trim() };
}

function normalizeAuthoringObjective(input: {
  input: Readonly<{ authoringObjective?: unknown }>;
  descriptor: WorkerCapabilityDescriptor;
  workerPrincipal: boolean;
}): NormalizedAuthoringObjective {
  const supplied = Object.hasOwn(input.input, "authoringObjective");
  const required =
    input.workerPrincipal &&
    input.descriptor.requiresPayloadAuthoringObjective === true;
  if (!required && supplied) {
    return { ok: false, issueCode: "authoring_objective_forbidden" };
  }
  if (!required) return { ok: true };
  if (!supplied) {
    return { ok: false, issueCode: "authoring_objective_required" };
  }
  const value = input.input.authoringObjective;
  if (!isValidAuthoringObjective(value)) {
    return { ok: false, issueCode: "authoring_objective_invalid" };
  }
  return { ok: true, value: value.trim() };
}

function isValidAuthoringObjective(input: unknown): input is string {
  if (typeof input !== "string") return false;
  if (input.trim().length === 0) return false;
  return input.length <= WORKER_CAPABILITY_AUTHORING_OBJECTIVE_MAX_LENGTH;
}

function hasValidCapabilityBatchCardinality(input: unknown): boolean {
  return Array.isArray(input) && input.length >= 2;
}
