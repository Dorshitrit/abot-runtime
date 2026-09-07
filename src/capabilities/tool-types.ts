import type { ModelStep } from "../shared/types.js";
import type { RuntimeAttachmentKind } from "../shared/attachments.js";
import type { ToolNormalInvocationContract } from "./normal-invocation/contracts.js";

export type {
  ToolNormalInvocationApproval,
  ToolNormalInvocationArrayInput,
  ToolNormalInvocationBooleanInput,
  ToolNormalInvocationBoundedStringInput,
  ToolNormalInvocationContract,
  ToolNormalInvocationEnumInput,
  ToolNormalInvocationEffect,
  ToolNormalInvocationFixedValue,
  ToolNormalInvocationInput,
  ToolNormalInvocationInputValidation,
  ToolNormalInvocationNumberInput,
  ToolNormalInvocationOperation,
  ToolNormalInvocationPayload,
  ToolNormalInvocationPropertyInput,
  ToolNormalInvocationScalarInput,
  ToolNormalInvocationUnboundedStringInput,
} from "./normal-invocation/contracts.js";

export type ToolRoutingCapability =
  | "filesystem_inspection"
  | "filesystem_mutation"
  | "semantic_lookup"
  | "semantic_mutation"
  | "web_lookup";

export type ToolDevelopmentRole =
  | "inspect"
  | "establish"
  | "mutate"
  | "verify"
  | "auxiliary";

export const TOOL_CATALOG_GROUP_ID_MAX_LENGTH = 128;

export type ToolCatalogGroup = string;

export function isToolCatalogGroupId(
  input: unknown,
): input is ToolCatalogGroup {
  return (
    typeof input === "string" &&
    input.length > 0 &&
    input.length <= TOOL_CATALOG_GROUP_ID_MAX_LENGTH &&
    /^[a-z0-9][a-z0-9._-]*$/u.test(input)
  );
}

export type ToolExecutionEffect = "read_only" | "mutating" | "mixed";

export type ToolControlsRefinement = "mechanical_when_complete";

export type ToolEventMetadataProjection = Readonly<{
  param: string;
  kind: "string" | "number" | "string_array" | "length";
  default?: string | number | boolean;
}>;

export type ToolEventLifecycleCopy = Readonly<{
  status: string;
  message: string;
}>;

export type ToolEventResultMetadataProjection = Readonly<{
  path: string;
  kind: "preview" | "number" | "boolean";
}>;

export type ToolEventPresentation = Readonly<{
  metadata: Readonly<Record<string, ToolEventMetadataProjection>>;
  resultMetadata?: Readonly<Record<string, ToolEventResultMetadataProjection>>;
  lifecycle?: Readonly<{
    started?: ToolEventLifecycleCopy;
    completed?: ToolEventLifecycleCopy;
    failed?: ToolEventLifecycleCopy;
  }>;
}>;

export type ToolParamsByCommand = {
  discriminator: string;
  variants: Record<string, Record<string, string>>;
};

export type ToolPayloadChannelSpec = {
  params: string[];
  outputParam: string;
  generationMode: "raw_text";
  targetParam?: string;
  targetRole?: "payload_body" | "operation_target";
  contextScope?: "standard" | "target_only" | "target_with_artifacts";
  targetContext?: "bounded" | "full" | "full_numbered";
  responseFormat?: "json" | Record<string, unknown>;
  promptHint?: string;
  stages?: ToolPayloadChannelStageSpec[];
  groundingWindow?: number;
  requiresCurrentTargetObservation?: {
    targetParam: string;
    contentRequirement?: "any" | "full";
  };
};

export const TOOL_PAYLOAD_STAGE_LITERAL_OUTPUT_MAX_BYTES = 4_096;

export type ToolPayloadChannelStageSpec = {
  outputParam: string;
  contextScope?: "standard" | "target_only" | "target_with_artifacts";
  targetContext?: "bounded" | "full" | "full_numbered";
  responseFormat?: "json" | Record<string, unknown>;
  targetLineBoundProperties?: string[];
  promptHint?: string;
  includeMaterializedParams?: string[];
  minBytes?: number;
  minBytesOverride?: ToolPayloadChannelStageMinBytesOverride;
  literalOutput?: ToolPayloadChannelStageLiteralOutput;
};

export type ToolPayloadChannelStageMinBytesOverride = Readonly<{
  materializedParam: string;
  property: string;
  equals: string;
  minBytes: number;
}>;

export type ToolPayloadChannelStageLiteralOutput = Readonly<{
  when: Readonly<{
    materializedParam: string;
    property: string;
    equals: string;
  }>;
  value: string;
}>;

export type ToolRuntimePathBinding = Readonly<{
  operationId: string;
  param: string;
  base: "worker_working_directory";
  default?: ".";
}>;

export type ToolDefinition = {
  name: string;
  description?: string;
  routingCapability: ToolRoutingCapability;
  controlsRefinement?: ToolControlsRefinement;
  catalogGroups?: ToolCatalogGroup[];
  executionEffect?: ToolExecutionEffect;
  developmentRoles?: ToolDevelopmentRole[];
  eventPresentation?: ToolEventPresentation;
  params: Record<string, string>;
  paramsByCommand?: ToolParamsByCommand;
  payloadChannelSpec?: ToolPayloadChannelSpec;
  runtimePathBindings?: ToolRuntimePathBinding[];
};

export type CanonicalToolDefinitionDeclaration = Omit<
  ToolDefinition,
  "params" | "executionEffect"
> & {
  params?: never;
  executionEffect?: never;
};

export type ToolDefinitionDeclaration = CanonicalToolDefinitionDeclaration;

export type ToolExecutionRequestContext = Readonly<{
  agentMode: "fast" | "reasoning" | "deep";
  toolPermissionMode: "ask" | "full_access";
  modelPreference?: Readonly<{
    profileId: string;
    scope?: "main" | "all";
  }>;
}>;

export type ToolRequestAttachment = Readonly<{
  id: string;
  kind: RuntimeAttachmentKind;
  mimeType: string;
  absolutePath: string;
  name?: string;
  size?: number;
}>;

/** Minimal config-filtered tool fact; consumers project it for their own context. */
export type ToolAvailabilityEntry = Readonly<{
  toolName: string;
  operationId: string;
  summary: string;
  catalogGroups: readonly ToolCatalogGroup[];
  effect: ToolExecutionEffect;
}>;

export type ToolExecutionSharedState = {
  activeDirectory?: string;
  currentSessionId?: string;
  requestContext?: ToolExecutionRequestContext;
  requestAttachments?: readonly ToolRequestAttachment[];
  /** Read-only request-effective catalog; never projected to a model directly. */
  availableTools?: readonly ToolAvailabilityEntry[];
  runtimePaths?: {
    rootDir?: string;
    runtimeDir?: string;
    agentWorkDir?: string;
    sessionsDir?: string;
    workspaceDir?: string;
    sharedDir?: string;
    compiledDir?: string;
    traceFile?: string;
  };
};

export type RuntimeToolPathLocation =
  | "agent_work"
  | "workspace"
  | "runtime_root"
  /** Explicit opt-in for read-only tools that inspect arbitrary host paths. */
  | "host_system";

export type RuntimeToolPathErrorCode =
  | "runtime_tool_path_required"
  | "runtime_tool_path_null_byte"
  | "runtime_tool_path_location_required"
  | "runtime_tool_path_root_unavailable"
  | "runtime_tool_path_workspace_unavailable"
  | "runtime_tool_path_outside_configured_roots"
  | "runtime_tool_path_symlink_escape"
  | "runtime_tool_path_canonicalization_failed"
  | "runtime_tool_path_traversal"
  | "runtime_tool_path_outside_working_directory";

export type RuntimeToolPathError = TypeError &
  Readonly<{ code: RuntimeToolPathErrorCode }>;

export type ResolvedRuntimeToolPath = Readonly<{
  location: RuntimeToolPathLocation;
  rootPath: string;
  absolutePath: string;
  relativePath: string;
  logicalPath: string;
}>;

export type RuntimeToolPathResolver = Readonly<{
  resolve(
    rawPath: unknown,
    options?: Readonly<{
      defaultPath?: string;
      requirePath?: boolean;
      allowedLocations?: readonly RuntimeToolPathLocation[];
    }>,
  ): ResolvedRuntimeToolPath;
}>;

export type ToolModelInvoker = Readonly<{
  invokeText(
    input: Readonly<{
      modelStep: ModelStep;
      instructions?: string;
      prompt: string;
      timeoutReason: string;
      format?: "json" | Record<string, unknown>;
    }>,
  ): Promise<string>;
}>;

export type ToolExecutionContext = {
  abortSignal?: AbortSignal;
  sharedState?: ToolExecutionSharedState;
  /** Runtime-owned path interpretation and containment authority. */
  runtimePathResolver?: RuntimeToolPathResolver;
  /** Trusted request-bound service for tools whose own implementation uses a model. */
  modelInvoker?: ToolModelInvoker;
};

export type ToolImplementation = (
  params: Record<string, unknown>,
  context?: ToolExecutionContext,
) => Promise<ToolImplementationOutput>;

export type ToolCallAdapterInput = {
  tool: string;
  params: Record<string, unknown>;
};

export type ToolCallAdapter = {
  normalizeCall?: (input: ToolCallAdapterInput) => ToolCall;
  validateCall?: (
    input: ToolCallAdapterInput,
  ) => { error: string; repairHint?: string } | null;
};

export type ToolModule = {
  definition: ToolDefinition;
  implementation: ToolImplementation;
  adapter?: ToolCallAdapter;
  normalInvocation: ToolNormalInvocationContract;
};

type ToolModuleDeclarationBase = Omit<
  ToolModule,
  "definition" | "normalInvocation"
>;

export type ToolModuleDeclaration = ToolModuleDeclarationBase & {
  definition: CanonicalToolDefinitionDeclaration;
  normalInvocation: ToolNormalInvocationContract;
};

export type RegisteredToolNormalInvocation = Readonly<{
  toolName: string;
  definition: ToolDefinition;
  contract: ToolNormalInvocationContract;
  adapter?: ToolCallAdapter;
}>;

export type ToolCall = {
  tool: string;
  params: Record<string, unknown>;
  clientStatus?: string;
};

export type ToolActionSummary = {
  type: string;
  target?: string;
  details?: string;
};

export type ToolObservationKind =
  | "stable_fact"
  | "volatile_external"
  | "task_result";

export type ToolObservationCarryPolicy = "always" | "never";

export type AuthoritativePlannedWorkTaskResultRole =
  | "authoritative_project_handoff"
  | "authoritative_planned_work_handoff_v1";
export type ToolObservationTaskResultRole =
  | AuthoritativePlannedWorkTaskResultRole
  | "supplemental_follow_up";

export type ToolObservationMeta = {
  kind: ToolObservationKind;
  carryPolicy: ToolObservationCarryPolicy;
  taskResultRole?: ToolObservationTaskResultRole;
};

export type ToolEventMetadata = {
  [key: string]: unknown;
};

export type ParsedToolCall =
  | { ok: true; call: ToolCall }
  | { ok: false; error: string; repairHint?: string };

export type ToolExecutionResult = {
  ok: boolean;
  tool: string;
  output: string;
  progress?: boolean;
  producedNewInformation: boolean;
  actions?: ToolActionSummary[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  data?: {
    hasData?: boolean;
    itemCount?: number;
    mutationEvidence?: boolean;
    mutationGrounding?: string;
    currentStateEvidence?: boolean;
    stateAlreadySatisfied?: boolean;
    observationMeta?: ToolObservationMeta;
    eventMeta?: ToolEventMetadata;
    [key: string]: unknown;
  };
  error?: string;
  errorCode?: string;
};

export type ToolImplementationOutput = {
  ok: boolean;
  output: string;
  progress?: boolean;
  producedNewInformation: boolean;
  actions?: ToolActionSummary[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  data?: {
    hasData?: boolean;
    itemCount?: number;
    mutationEvidence?: boolean;
    mutationGrounding?: string;
    currentStateEvidence?: boolean;
    stateAlreadySatisfied?: boolean;
    observationMeta?: ToolObservationMeta;
    eventMeta?: ToolEventMetadata;
    [key: string]: unknown;
  };
  error?: string;
  errorCode?: string;
};
