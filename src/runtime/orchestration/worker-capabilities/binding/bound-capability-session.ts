import {
  isRoleCapabilityId,
  type RoleCallDependencyResult,
  type RoleCallFrame,
  type RoleCallLedger,
} from "../../role-calls/index.js";
import type {
  WorkerCapabilityAdapter,
  WorkerCapabilityBinding,
  WorkerCapabilityDescriptor,
  WorkerCapabilityExecutionFreshness,
} from "../contracts.js";
import type { WorkerCapabilityDiagnosticContext } from "../diagnostics.js";
import {
  executeBoundWorkerCapability,
  executeBoundWorkerCapabilityBatch,
} from "../execution.js";
import type { WorkerCapabilityScopeProjection } from "../scope.js";
import { resolveLiveCapabilityCall } from "./call-authority.js";
import { CapabilityInvocationPreparer } from "./invocation-preparation.js";

/**
 * Immutable request/call-scoped capability facade. Authoritative ledger state
 * is deliberately resolved per invocation and is never stored on the session.
 */
export class BoundCapabilitySession<TContext> {
  readonly #requestId: string;
  readonly #context: TContext;
  readonly #boundCall: RoleCallFrame;
  readonly #ledger: RoleCallLedger;
  readonly #capabilities: readonly WorkerCapabilityDescriptor[];
  readonly #diagnostic: WorkerCapabilityDiagnosticContext;
  readonly #capabilityScope: WorkerCapabilityScopeProjection<
    WorkerCapabilityAdapter<TContext>
  >;
  readonly #executionFreshness?: WorkerCapabilityExecutionFreshness;
  readonly #dependencyResults: readonly RoleCallDependencyResult[];
  readonly #invocationPreparer: CapabilityInvocationPreparer<TContext>;

  constructor(params: {
    requestId: string;
    context: TContext;
    boundCall: RoleCallFrame;
    ledger: RoleCallLedger;
    capabilities: readonly WorkerCapabilityDescriptor[];
    byCapabilityId: ReadonlyMap<string, WorkerCapabilityAdapter<TContext>>;
    diagnostic: WorkerCapabilityDiagnosticContext;
    capabilityScope: WorkerCapabilityScopeProjection<
      WorkerCapabilityAdapter<TContext>
    >;
    dependencyResults: readonly RoleCallDependencyResult[];
    executionFreshness?: WorkerCapabilityExecutionFreshness;
  }) {
    this.#requestId = params.requestId;
    this.#context = params.context;
    this.#boundCall = params.boundCall;
    this.#ledger = params.ledger;
    this.#capabilities = params.capabilities;
    this.#diagnostic = params.diagnostic;
    this.#capabilityScope = params.capabilityScope;
    this.#dependencyResults = params.dependencyResults;
    this.#executionFreshness = params.executionFreshness;
    this.#invocationPreparer = new CapabilityInvocationPreparer({
      boundCall: params.boundCall,
      byCapabilityId: params.byCapabilityId,
      capabilityScope: params.capabilityScope,
      diagnostic: params.diagnostic,
    });
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
    const attemptedCapabilityId = isRoleCapabilityId(input.capabilityId)
      ? input.capabilityId
      : undefined;
    const { currentHead, currentCall } = resolveLiveCapabilityCall({
      requestId: this.#requestId,
      boundCall: this.#boundCall,
      ledger: this.#ledger,
      diagnostic: this.#diagnostic,
      ...(attemptedCapabilityId ? { attemptedCapabilityId } : {}),
    });
    const invocation = this.#invocationPreparer.prepareSingle(input);
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
    const { currentHead, currentCall } = resolveLiveCapabilityCall({
      requestId: this.#requestId,
      boundCall: this.#boundCall,
      ledger: this.#ledger,
      diagnostic: this.#diagnostic,
    });
    const invocations = this.#invocationPreparer.prepareBatch(
      input.invocations,
    );
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
}
