import type {
  RegisteredToolNormalInvocation,
  ToolExecutionRequestContext,
  ToolNormalInvocationOperation,
} from "../../../capabilities/tool-types.js";
import type {
  WorkerCapabilityDescriptor,
  WorkerCapabilityPayloadAuthor,
} from "../../orchestration/worker-capabilities/index.js";
import type {
  ToolApprovalController,
  ToolPermissionMode,
  ToolRegistry,
} from "../../ports.js";
import type { RegisteredToolStagedPayloadPlan } from "../registered-tool-payload-plan.js";

export type RegisteredToolWorkerCapabilityProviderParams = Readonly<{
  /**
   * Must return the already config-filtered, request-bound registry. The
   * callback is first invoked when a caller requests the public descriptor
   * catalog. Execution state and adapters remain lazy until getAdapters().
   */
  getRequestToolRegistry(): ToolRegistry;
  requestId: string;
  sessionId: string;
  requestContext?: ToolExecutionRequestContext;
  abortSignal: AbortSignal;
  toolPermissionMode: ToolPermissionMode;
  toolApprovalController?: ToolApprovalController;
  payloadAuthor?: WorkerCapabilityPayloadAuthor;
  loadActionSkillContext?(toolName: string): Promise<string>;
  nextApprovalId(): string;
  onEvent?(name: string, payload: Record<string, unknown>): void;
}>;

export type SelectedOperation = Readonly<{
  registration: RegisteredToolNormalInvocation;
  operation: ToolNormalInvocationOperation;
  stagedPayloadPlan?: RegisteredToolStagedPayloadPlan;
}>;

export type ResolvedCapabilityCatalog = Readonly<{
  registry: ToolRegistry;
  selected: readonly SelectedOperation[];
  operationIds: readonly string[];
  descriptors: readonly WorkerCapabilityDescriptor[];
}>;
