import type {
  RegisteredToolNormalInvocation,
  ToolActionSummary,
  ToolExecutionResult,
  ToolExecutionSharedState,
  ToolNormalInvocationEffect,
  ToolNormalInvocationOperation,
} from "../../../../capabilities/tool-types.js";
import type {
  ToolApprovalController,
  ToolPermissionMode,
  ToolRegistry,
} from "../../../ports.js";
import type {
  RegisteredToolPayloadContextPlan,
  RegisteredToolStagedPayloadPlan,
} from "../../registered-tool-payload-plan.js";

/**
 * Opaque request-scoped authority for one config-filtered ordinary operation.
 * The handle is bound through a WeakMap and cannot be reconstructed by model
 * output, profile data or a structurally similar object.
 */
export type RegisteredToolNormalInvocationHandle = Readonly<{
  kind: "registered_tool_normal_invocation_handle";
}>;

export type RegisteredToolNormalInvocationProjection = Readonly<{
  handle: RegisteredToolNormalInvocationHandle;
  operation: ToolNormalInvocationOperation;
  runtimePathBindings?: readonly Readonly<{
    param: string;
    default?: ".";
  }>[];
  payloadContextPlan?: RegisteredToolPayloadContextPlan;
  stagedPayloadPlan?: RegisteredToolStagedPayloadPlan;
}>;

export type RegisteredToolNormalInvocationRejection = Readonly<{
  status: "rejected";
  code: string;
  message: string;
}>;

export type RegisteredToolNormalInvocationExecution = Readonly<{
  status: "executed";
  effect: ToolNormalInvocationEffect;
  result: ToolExecutionResult;
  completionActions: readonly ToolActionSummary[];
}>;

export type RegisteredToolNormalInvocationResult =
  | RegisteredToolNormalInvocationExecution
  | RegisteredToolNormalInvocationRejection;

export type RegisteredToolNormalInvocationPayloadLifecyclePhase =
  | "started"
  | "completed"
  | "failed";

export type RegisteredToolNormalInvocationPayloadLifecycleResult =
  | Readonly<{ status: "emitted" }>
  | RegisteredToolNormalInvocationRejection;

export type RegisteredToolNormalInvocationExecutor = Readonly<{
  operations: readonly RegisteredToolNormalInvocationProjection[];
  /**
   * Emits the existing client payload lifecycle without exposing the bound
   * tool name or payload parameter to the profile that owns model context.
   */
  emitPayloadLifecycle(
    input: Readonly<{
      handle: RegisteredToolNormalInvocationHandle;
      controls: Readonly<Record<string, unknown>>;
      /** Client-facing lifecycle metadata; never part of tool parameters. */
      intent?: string;
      phase: RegisteredToolNormalInvocationPayloadLifecyclePhase;
      errorCode?: string;
      payloadStage?: number;
      payloadStageCount?: number;
      outputParam?: string;
    }>,
  ): RegisteredToolNormalInvocationPayloadLifecycleResult;
  execute(
    input: Readonly<{
      handle: RegisteredToolNormalInvocationHandle;
      controls: Readonly<Record<string, unknown>>;
      payload?: string;
      materializedParams?: Readonly<Record<string, string>>;
      /** Client-facing lifecycle metadata; never part of tool parameters. */
      intent?: string;
    }>,
  ): Promise<RegisteredToolNormalInvocationResult>;
}>;

export type BoundOperation = Readonly<{
  registration: RegisteredToolNormalInvocation;
  operation: ToolNormalInvocationOperation;
  runtimePathBindings?: readonly Readonly<{
    param: string;
    default?: ".";
  }>[];
  payloadContextPlan?: RegisteredToolPayloadContextPlan;
  stagedPayloadPlan?: RegisteredToolStagedPayloadPlan;
}>;

export type RegisteredToolNormalInvocationExecutorParams = Readonly<{
  registrations: readonly RegisteredToolNormalInvocation[];
  toolRegistry: Pick<ToolRegistry, "execute">;
  requestId: string;
  abortSignal: AbortSignal;
  sharedState?: ToolExecutionSharedState;
  toolPermissionMode: ToolPermissionMode;
  toolApprovalController?: ToolApprovalController;
  nextApprovalId(): string;
  onEvent?(name: string, payload: Record<string, unknown>): void;
}>;

export type RegisteredToolNormalInvocationPayloadLifecycleInput = Parameters<
  RegisteredToolNormalInvocationExecutor["emitPayloadLifecycle"]
>[0];

export type RegisteredToolNormalInvocationExecutionInput = Parameters<
  RegisteredToolNormalInvocationExecutor["execute"]
>[0];
