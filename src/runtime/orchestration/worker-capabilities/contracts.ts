import {
  ROLE_CAPABILITY_ID_MAX_LENGTH,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  type RoleCallFrame,
  type RoleCallDependencyResult,
  type RoleCallLedger,
  type RoleCallOperationSupervisionInterventionCommit,
  type RoleCapabilityEffect,
  type RoleCapabilityDeclaredEffect,
  type RoleCapabilityExecutionOutcome,
  type RoleCapabilityObservedEffect,
  type RoleCapabilityResultReference,
} from "../role-calls/index.js";
import type {
  ToolCatalogGroup,
  ToolDevelopmentRole,
  ToolRoutingCapability,
} from "../../../capabilities/tool-types.js";
import type { CapabilityAdapterResult } from "../capability-adapters/result.js";

export const WORKER_CAPABILITY_ID_MAX_LENGTH = ROLE_CAPABILITY_ID_MAX_LENGTH;
/** Client-facing capability narration; never an execution objective or payload. */
export const WORKER_CAPABILITY_INTENT_MAX_LENGTH = 500;
/** Immutable Worker-only assignment for authoring one capability payload. */
export const WORKER_CAPABILITY_AUTHORING_OBJECTIVE_MAX_LENGTH =
  ROLE_CALL_OBJECTIVE_MAX_LENGTH;
export const WORKER_CAPABILITY_SUMMARY_MAX_LENGTH = 512;
export const WORKER_CAPABILITY_COUNT_MAX = 64;
export const WORKER_CAPABILITY_CONTROL_COUNT_MAX = 16;
export const WORKER_CAPABILITY_CONTROL_ID_MAX_LENGTH = 64;
export const WORKER_CAPABILITY_CONTROL_STRING_MAX_LENGTH = 4_096;
export const WORKER_CAPABILITY_CONTROL_ENUM_MAX_VALUES = 64;
export const WORKER_CAPABILITY_CONTROL_ENUM_VALUE_MAX_LENGTH = 256;
export const WORKER_CAPABILITY_CONTROL_ARRAY_MAX_ITEMS = 64;

export type WorkerCapabilityEffect = RoleCapabilityDeclaredEffect;
export type WorkerCapabilityObservedEffect = RoleCapabilityObservedEffect;
declare const WORKER_CAPABILITY_ASSIGNMENT_PROVENANCE_BRAND: unique symbol;
export type WorkerCapabilityAssignmentProvenance = Readonly<{
  kind: "planner_plan_item_v1";
  requestId: string;
  sourceRevision: number;
  plannerCallId: string;
  planId: string;
  itemId: string;
  workerCallId: string;
  invocationAttempt: number;
  readonly [WORKER_CAPABILITY_ASSIGNMENT_PROVENANCE_BRAND]: true;
}>;

declare const WORKER_CAPABILITY_REQUEST_PROVENANCE_BRAND: unique symbol;
export type WorkerCapabilityRequestScopedProvenance = Readonly<{
  kind: "request_scoped_worker_v1";
  requestId: string;
  sourceRevision: number;
  callerCallId: string;
  workerCallId: string;
  invocationAttempt: number;
  readonly [WORKER_CAPABILITY_REQUEST_PROVENANCE_BRAND]: true;
}>;

/** Runtime-issued request-source authority for one Worker payload. */
export type WorkerCapabilityPayloadSourceProvenance =
  | WorkerCapabilityAssignmentProvenance
  | WorkerCapabilityRequestScopedProvenance;

export type WorkerCapabilityBoundedStringControl = Readonly<{
  type: "string";
  minLength: number;
  maxLength: number;
}>;

export type WorkerCapabilityUnboundedStringControl = Readonly<{
  type: "string";
  minLength: number;
}>;

export type WorkerCapabilityEnumControl = Readonly<{
  type: "string";
  enum: readonly string[];
}>;

export type WorkerCapabilityNumberControl = Readonly<{
  type: "number" | "integer";
  minimum: number;
  maximum: number;
}>;

export type WorkerCapabilityBooleanControl = Readonly<{
  type: "boolean";
}>;

export type WorkerCapabilityScalarControl =
  | WorkerCapabilityBoundedStringControl
  | WorkerCapabilityUnboundedStringControl
  | WorkerCapabilityEnumControl
  | WorkerCapabilityNumberControl
  | WorkerCapabilityBooleanControl;

export type WorkerCapabilityArrayControl = Readonly<{
  type: "array";
  items: WorkerCapabilityScalarControl;
  minItems: number;
  maxItems: number;
}>;

export type WorkerCapabilityControl =
  | WorkerCapabilityScalarControl
  | WorkerCapabilityArrayControl;

export type WorkerCapabilityControlsSchema = Readonly<{
  type: "object";
  additionalProperties: false;
  properties: Readonly<Record<string, WorkerCapabilityControl>>;
  required: readonly string[];
}>;

export const EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA: WorkerCapabilityControlsSchema =
  Object.freeze({
    type: "object" as const,
    additionalProperties: false as const,
    properties: Object.freeze({}),
    required: Object.freeze([]),
  });

export type WorkerCapabilityDescriptor = Readonly<{
  capabilityId: string;
  summary: string;
  effect: WorkerCapabilityEffect;
  controls: WorkerCapabilityControlsSchema;
  /** Manifest-declared controls whose values use runtime path semantics. */
  runtimePathControlIds?: readonly string[];
  /** Controls selected and frozen with capability identity before refinement. */
  selectionControlIds?: readonly string[];
  /** Allows mechanical execution only when selection owns every control. */
  controlsRefinement?: "mechanical_when_complete";
  /** Manifest-owned routing metadata projected only in capability selection. */
  catalogGroups?: readonly ToolCatalogGroup[];
  /** Manifest-owned semantic routing class for this capability. */
  routingCapability?: ToolRoutingCapability;
  /** Manifest-owned development phases served by this capability. */
  developmentRoles?: readonly ToolDevelopmentRole[];
  /** Canonical payload contract requires a Worker authoring receipt. */
  requiresPayloadAuthoringObjective?: true;
}>;

export type WorkerCapabilityControls = Readonly<Record<string, unknown>>;

/**
 * Optional root-owned admission fence carried through the shared capability
 * engine. Worker bindings omit it, so their adapter and payload contracts stay
 * byte-compatible.
 */
export type WorkerCapabilityExecutionFreshness = Readonly<{
  token: Readonly<{
    kind: "request_steering_v1";
    version: number;
    updates: readonly Readonly<{
      sequence: number;
      text: string;
    }>[];
  }>;
  isCurrent(): boolean;
}>;

export type WorkerCapabilityAdapterResult =
  | Readonly<{
      outcome: "succeeded";
      observedEffect: RoleCapabilityEffect;
      summary: string;
      referenceData?: string;
      references?: readonly RoleCapabilityResultReference[];
      /** Canonical adapter-owned result persisted for every settled execution. */
      exactResult?: CapabilityAdapterResult;
    }>
  | Readonly<{
      outcome: "failed";
      observedEffect: WorkerCapabilityObservedEffect;
      summary: string;
      referenceData?: string;
      references?: readonly RoleCapabilityResultReference[];
      /** Canonical adapter-owned result persisted for every settled execution. */
      exactResult?: CapabilityAdapterResult;
      /**
       * Opaque adapter-owned stable failure identity. `null` explicitly opts
       * this one failure out of supervision; omission is a contract violation.
       */
      failureOutcomeFingerprint: string | null;
    }>;

export type WorkerCapabilityAdapterExecutionInput<TContext> = Readonly<{
  context: TContext;
  call: RoleCallFrame;
  /** Runtime-only proof of the exact request source allowed for this payload. */
  assignmentProvenance?: WorkerCapabilityPayloadSourceProvenance;
  executionId: string;
  /** Client-facing presentation metadata for lifecycle events only. */
  intent: string;
  /** Worker-only payload assignment; forbidden for root and non-payload calls. */
  authoringObjective?: string;
  controls: WorkerCapabilityControls;
  settledCapabilityResults: readonly WorkerSettledCapabilityResult[];
  dependencyResults?: readonly RoleCallDependencyResult[];
  executionFreshness?: WorkerCapabilityExecutionFreshness;
}>;

export type WorkerCapabilityPreparedExecution = Readonly<{
  /** Opaque exact-action identity required from every preparing adapter. */
  actionFingerprint?: string;
  /**
   * Canonical non-payload controls accepted by the preparing adapter,
   * including any adapter-validated staged controls hidden from selection.
   */
  acceptedControls: WorkerCapabilityControls;
  execute(executionId: string): Promise<WorkerCapabilityAdapterResult>;
}>;

export type WorkerCapabilityAdapterPreparationInput<TContext> = Readonly<
  Omit<WorkerCapabilityAdapterExecutionInput<TContext>, "executionId"> & {
    /** Non-canonical correlation for payload preparation and diagnostics only. */
    preparationId: string;
  }
>;

export type WorkerCapabilityExecutionReference = Readonly<{
  executionId: string;
}>;

export type WorkerCapabilityOperationInterventionReference = Readonly<{
  kind: "operation_supervision_intervened";
  commit: RoleCallOperationSupervisionInterventionCommit;
}>;

export type WorkerCapabilityAttemptReference =
  | WorkerCapabilityExecutionReference
  | WorkerCapabilityOperationInterventionReference;

export type WorkerCapabilityBatchExecutionReference = Readonly<{
  executionIds: readonly string[];
}>;

export type WorkerCapabilityBatchAttemptReference =
  | WorkerCapabilityBatchExecutionReference
  | WorkerCapabilityOperationInterventionReference;

export type WorkerCapabilityInvocation = Readonly<{
  capabilityId: string;
  /** Client-facing presentation metadata; execution must not infer from it. */
  intent: string;
  /** Present only when the selected descriptor requires payload authoring. */
  authoringObjective?: string;
  controls: WorkerCapabilityControls;
}>;

export type WorkerSettledCapabilityResult = Readonly<{
  executionId: string;
  callId: string;
  invocationAttempt: number;
  capabilityId: string;
  declaredEffect: RoleCapabilityDeclaredEffect;
  outcome: RoleCapabilityExecutionOutcome;
  observedEffect: RoleCapabilityObservedEffect;
  summary: string;
  referenceData?: string;
  references?: readonly RoleCapabilityResultReference[];
  /** Exact evidence owned by this producing call. */
  adapterResult: CapabilityAdapterResult;
}>;

export type WorkerCapabilityAdapter<TContext> = Readonly<{
  descriptor: WorkerCapabilityDescriptor;
  /**
   * Optional exact-action preparation seam. Production tool adapters use this
   * to materialize and normalize the complete invocation before admission.
   * It must not perform the capability's externally observable effect; only
   * the returned execute closure may do that after canonical admission.
   */
  prepare?(
    input: WorkerCapabilityAdapterPreparationInput<TContext>,
  ): Promise<WorkerCapabilityPreparedExecution>;
  execute(
    input: WorkerCapabilityAdapterExecutionInput<TContext>,
  ): Promise<WorkerCapabilityAdapterResult>;
}>;

/**
 * Lazy request-scoped source of neutral Worker capabilities. Implementations
 * may resolve external adapters, but orchestration never imports or selects
 * those external systems itself.
 */
export type WorkerCapabilityAdapterProvider<TContext> = Readonly<{
  /**
   * Returns the exact request-scoped public capability descriptors without
   * constructing execution adapters or preparing tool execution state.
   */
  getDescriptors(): readonly WorkerCapabilityDescriptor[];
  /**
   * Resolves one-time model guidance only after a capability was selected and
   * before its adapter is allowed to execute. The returned content is scoped
   * to that pending invocation and must not be persisted into later turns.
   */
  getExecutionGuidance?(capabilityId: string): Promise<string>;
  getAdapters(): readonly WorkerCapabilityAdapter<TContext>[];
}>;

export type WorkerCapabilityBinding<TContext> = Readonly<{
  requestId: string;
  ledger: RoleCallLedger;
  callId: string;
  invocationAttempt: number;
  capabilities: readonly WorkerCapabilityDescriptor[];
  execute(
    input: Readonly<{
      capabilityId: string;
      intent: unknown;
      authoringObjective?: unknown;
      controls: unknown;
    }>,
  ): Promise<WorkerCapabilityAttemptReference>;
  executeBatch(
    input: Readonly<{
      invocations: readonly Readonly<{
        capabilityId: string;
        intent: unknown;
        authoringObjective?: unknown;
        controls: unknown;
      }>[];
    }>,
  ): Promise<WorkerCapabilityBatchAttemptReference>;
}>;
