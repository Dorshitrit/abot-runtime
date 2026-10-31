import { bindKnowledgeSkillsToRequest } from "../knowledge-skills/request-store.js";
import type { InformationBasketService } from "../information-basket/contracts.js";
import { hasInformationBasketReadAccess } from "../information-basket/request-candidates.js";
import type { InformationBasketCandidateSource } from "../information-basket/request-candidates.js";
import { matchesToolSelectionId } from "../../shared/tool-selection.js";
import { CORE_TOOL_CONTRACTS } from "../capabilities/core-tool-contracts.js";
import { captureModelPluginConfig } from "../config/model-plugin-config.js";
import type { KnowledgeSkillStore } from "../knowledge-skills/store.js";
import type { AvailableSkillsSource } from "../knowledge-skills/available-skills.js";
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
import { createSupervisorSkillSelectionWindows, type SupervisorSkillSelectionWindows } from "./supervisor-skill-selection-window.js";

/** Request fields required while the request-bound capability catalog is built. */
export type RequestCapabilityCompositionView =
  BoundRequestModelInvocationContext &
    Readonly<
      Pick<
        RequestExecutionSeed,
        | "sessionId"
        | "prompt"
        | "historyMessages"
        | "sessionMemory"
        | "attachments"
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
    | "userInteractions"
  >
> &
  BoundRequestModelInvocationContext;

export type RequestWorkerCapabilities = Readonly<{
  filesystemScope?: RuntimeFilesystemScope;
  provider: WorkerCapabilityAdapterProvider<RequestCapabilityExecutionView> &
    Partial<ToolAvailabilitySource & AvailableSkillsSource & InformationBasketCandidateSource>;
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
    knowledgeSkillStore?: KnowledgeSkillStore;
    informationBasket?: InformationBasketService;
    supervisorSkillSelectionWindows: SupervisorSkillSelectionWindows;
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
    knowledgeSkillStore?: KnowledgeSkillStore;
    informationBasket?: InformationBasketService;
    requestWorkingDirectory?: string;
    executionPolicy: CompiledRequestExecutionPolicy;
    superFailureFinalization?: SuperFailureFinalization;
    createWorkerCapabilities(
      view: RequestCapabilityCompositionView,
      filesystemScope?: RuntimeFilesystemScope,
    ): RequestWorkerCapabilities["provider"];
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
    supervisorSkillSelectionWindows: createSupervisorSkillSelectionWindows(),
    ...(input.informationBasket && hasInformationBasketReadAccess(provider.getAvailableTools?.() ?? [])
      ? { informationBasket: input.informationBasket } : {}),
    ...(input.knowledgeSkillStore && !isSkillStoreDeniedForModel(input.seed)
      ? { knowledgeSkillStore: bindKnowledgeSkillsToRequest(input.knowledgeSkillStore, input.executionPolicy.rootContract.contractId) }
      : {}),
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


/** Direct core reads retain the same captured model restriction as abot_skills. */
function isSkillStoreDeniedForModel(seed: RequestExecutionSeed): boolean {
  const deniedSelectors = captureModelPluginConfig(
    seed.executionPolicySelection?.plugins,
  )?.deny ?? [];
  return deniedSelectors.some((selector) =>
    matchesToolSelectionId("", CORE_TOOL_CONTRACTS.skills.name, selector),
  );
}
