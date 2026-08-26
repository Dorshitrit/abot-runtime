import {
  ROLE_CAPABILITY_ID_MAX_LENGTH,
  type RoleCallFrame,
  type RoleCallDependencyResult,
  type RoleCallLedger,
  type RoleCapabilityEffect,
  type RoleCapabilityDeclaredEffect,
  type RoleCapabilityExecutionOutcome,
  type RoleCapabilityObservedEffect,
  type RoleCapabilityResultReference,
} from "../role-calls/index.js";
import type { ToolCatalogGroup } from "../../../capabilities/tool-types.js";
import type { CapabilityAdapterResult } from "../capability-adapters/result.js";

export const WORKER_CAPABILITY_ID_MAX_LENGTH = ROLE_CAPABILITY_ID_MAX_LENGTH;
/** Client-facing capability narration; never an execution objective or payload. */
export const WORKER_CAPABILITY_INTENT_MAX_LENGTH = 500;
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
    }>;

export type WorkerCapabilityExecutionReference = Readonly<{
  executionId: string;
}>;

export type WorkerCapabilityBatchExecutionReference = Readonly<{
  executionIds: readonly string[];
}>;

export type WorkerCapabilityInvocation = Readonly<{
  capabilityId: string;
  /** Client-facing presentation metadata; execution must not infer from it. */
  intent: string;
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
  execute(
    input: Readonly<{
      context: TContext;
      call: RoleCallFrame;
      executionId: string;
      /** Client-facing presentation metadata for lifecycle events only. */
      intent: string;
      controls: WorkerCapabilityControls;
      settledCapabilityResults: readonly WorkerSettledCapabilityResult[];
      dependencyResults?: readonly RoleCallDependencyResult[];
      executionFreshness?: WorkerCapabilityExecutionFreshness;
    }>,
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
      controls: unknown;
    }>,
  ): Promise<WorkerCapabilityExecutionReference>;
  executeBatch(
    input: Readonly<{
      invocations: readonly Readonly<{
        capabilityId: string;
        intent: unknown;
        controls: unknown;
      }>[];
    }>,
  ): Promise<WorkerCapabilityBatchExecutionReference>;
}>;
