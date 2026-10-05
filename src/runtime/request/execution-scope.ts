import {
  captureRuntimeFilesystemScope,
  type RuntimeFilesystemScope,
} from "../context/runtime-filesystem-scope.js";
import {
  createSuperFailureFinalization,
  type SuperFailureFinalization,
} from "./super-failure-explanation.js";
import { RequestModelStepInvoker } from "../model/invoke-step.js";
import type { ToolAvailabilitySource } from "../capabilities/tool-availability.js";
import type { WorkerCapabilityAdapterProvider } from "../orchestration/worker-capabilities/index.js";
import type {
  AcceptedRequestInput,
  BoundRequestModelInvocationContext,
  RequestSessionSnapshot,
  RequestExecutionSeed,
  RequestIdentity,
  RequestLifecycleRuntime,
  RequestModelInvocationView,
  RequestModelRuntime,
  RequestMemoryRuntime,
  RequestPresentation,
} from "./contracts.js";
import {
  createModelInvocationView,
  createRequestSeedFacets,
} from "./execution-facets.js";
import {
  createCapabilityCompositionView,
  createCapabilityExecutionView,
  createScopeSurface,
  REQUEST_EXECUTION_SCOPE,
} from "./execution-scope-surfaces.js";
import type { CompiledExecutionPolicy } from "./root-contract.js";

/** Request fields required while the request-bound capability catalog is built. */
export type RequestCapabilityCompositionView =
  BoundRequestModelInvocationContext &
    Readonly<
      Pick<
        RequestExecutionSeed,
        | "sessionId"
        | "prompt"
        | "historyMessages"
        | "toolPermissionMode"
        | "toolApprovalController"
        | "effectPersistence"
        | "onEvent"
        | "contextCompactionStore"
      >
    >;

/**
 * Stable request-owned context delivered to capability adapters.
 * Passive session artifact paths and request containers are excluded.
 */
export type RequestCapabilityExecutionView = Readonly<
  Omit<
    RequestExecutionSeed,
    | "sessionArtifactPaths"
    | "sessionMemory"
    | "longTermMemory"
    | "memoryRecallLimit"
    | "scheduledExecution"
  >
> &
  BoundRequestModelInvocationContext;

export type RequestWorkerCapabilities = Readonly<{
  filesystemScope?: RuntimeFilesystemScope;
  provider: WorkerCapabilityAdapterProvider<RequestCapabilityExecutionView> &
    Partial<ToolAvailabilitySource>;
  executionContext: RequestCapabilityExecutionView;
}>;

export type RequestExecutionPolicyFacet = Readonly<{
  selection?: RequestExecutionSeed["executionPolicySelection"];
  executionPolicy: CompiledExecutionPolicy<RequestExecutionScope>;
}>;

/** The single immutable request-scoped runtime object used after composition. */
export type RequestExecutionScope = RequestExecutionSeed &
  BoundRequestModelInvocationContext &
  Readonly<{
    identity: RequestIdentity;
    input: AcceptedRequestInput;
    session: RequestSessionSnapshot;
    model: RequestModelRuntime;
    memory: RequestMemoryRuntime;
    lifecycle: RequestLifecycleRuntime;
    presentation: RequestPresentation;
    policy: RequestExecutionPolicyFacet;
    modelInvocation: RequestModelInvocationView;
    executionPolicy: CompiledExecutionPolicy<RequestExecutionScope>;
    capabilities: RequestWorkerCapabilities;
    superFailureFinalization?: SuperFailureFinalization;
    workerCapabilities: RequestWorkerCapabilities;
  }>;

export type CompiledRequestExecutionPolicy =
  RequestExecutionScope["executionPolicy"];

export type RequestWorkerCapabilityProviderSource = Pick<
  RequestExecutionScope,
  "workerCapabilities"
>;

export type RequestWorkerCapabilityCatalog = Pick<
  WorkerCapabilityAdapterProvider<RequestCapabilityExecutionView>,
  "getDescriptors" | "getExecutionGuidance"
>;

export function createRequestExecutionScope(
  input: Readonly<{
    seed: RequestExecutionSeed;
    requestWorkingDirectory?: string;
    executionPolicy: CompiledRequestExecutionPolicy;
    superFailureFinalization?: SuperFailureFinalization;
    createWorkerCapabilities(
      view: RequestCapabilityCompositionView,
      filesystemScope?: RuntimeFilesystemScope,
    ): WorkerCapabilityAdapterProvider<RequestCapabilityExecutionView>;
  }>,
): RequestExecutionScope {
  const facets = createRequestSeedFacets(input.seed);
  const policy = createRequestExecutionPolicyFacet(
    input.seed.executionPolicySelection,
    input.executionPolicy,
  );
  const modelInvocation = createModelInvocationView(facets);
  const modelSteps = Object.freeze(
    new RequestModelStepInvoker(modelInvocation, facets.lifecycle.onEvent),
  );
  const executionContext = createCapabilityExecutionView(
    facets,
    policy.selection,
    modelSteps,
  );
  const filesystemScope = captureRuntimeFilesystemScope(
    input.requestWorkingDirectory,
  );
  const provider = input.createWorkerCapabilities(
    createCapabilityCompositionView(facets, modelSteps),
    filesystemScope,
  );
  const capabilities = Object.freeze({
    provider,
    executionContext,
    ...(filesystemScope ? { filesystemScope } : {}),
  });
  return createScopeSurface({
    facets,
    policy,
    modelInvocation,
    modelSteps,
    capabilities,
    superFailureFinalization:
      input.superFailureFinalization ??
      createSuperFailureFinalization({
        request: input.seed,
        executionPolicy: input.executionPolicy,
      }),
  });
}

export function resolveRequestWorkerCapabilities(
  input: RequestExecutionScope,
): RequestWorkerCapabilities {
  return input.workerCapabilities;
}

export function resolveRequestWorkerCapabilityCatalog(
  input: RequestWorkerCapabilityProviderSource,
): RequestWorkerCapabilityCatalog {
  return input.workerCapabilities.provider;
}

export function isRequestExecutionScope(
  input: object,
): input is RequestExecutionScope {
  return REQUEST_EXECUTION_SCOPE in input;
}

function createRequestExecutionPolicyFacet(
  selection: RequestExecutionSeed["executionPolicySelection"],
  executionPolicy: CompiledRequestExecutionPolicy,
): RequestExecutionPolicyFacet {
  return Object.freeze({
    ...(selection !== undefined ? { selection } : {}),
    executionPolicy,
  });
}
