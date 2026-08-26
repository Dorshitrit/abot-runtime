import type { RequestModelStepPort } from "../model/model-step-port.js";
import {
  BOUND_REQUEST_MODEL_INVOCATION,
  type RequestExecutionSeed,
  type RequestModelInvocationView,
} from "./contracts.js";
import type { RequestSeedFacets } from "./execution-facets.js";
import type {
  RequestCapabilityCompositionView,
  RequestCapabilityExecutionView,
  RequestExecutionPolicyFacet,
  RequestExecutionScope,
  RequestWorkerCapabilities,
} from "./execution-scope.js";
import {
  createFrozenSurface,
  enumerableGetter,
  hiddenValue,
} from "./immutable-view.js";

export const REQUEST_EXECUTION_SCOPE = Symbol("request_execution_scope");

export function createCapabilityCompositionView(
  facets: RequestSeedFacets,
  modelSteps: RequestModelStepPort,
): RequestCapabilityCompositionView {
  return createFrozenSurface<RequestCapabilityCompositionView>({
    requestId: enumerableGetter(() => facets.identity.requestId),
    runnerConfig: enumerableGetter(() => facets.model.runnerConfig),
    agentMode: enumerableGetter(() => facets.input.agentMode),
    ...(facets.model.modelPreference !== undefined
      ? {
          modelPreference: enumerableGetter(
            () => facets.model.modelPreference!,
          ),
        }
      : {}),
    ...(facets.model.modelPolicy !== undefined
      ? { modelPolicy: enumerableGetter(() => facets.model.modelPolicy!) }
      : {}),
    modelGatewayClient: enumerableGetter(() => facets.model.modelGatewayClient),
    ...(facets.lifecycle.requestSteering !== undefined
      ? {
          requestSteering: enumerableGetter(
            () => facets.lifecycle.requestSteering!,
          ),
        }
      : {}),
    abortSignal: enumerableGetter(() => facets.lifecycle.abortSignal),
    onThinkingDelta: enumerableGetter(
      () => facets.presentation.onThinkingDelta,
    ),
    onThinkingTrace: enumerableGetter(
      () => facets.presentation.onThinkingTrace,
    ),
    modelSteps: enumerableGetter(() => modelSteps),
    sessionId: enumerableGetter(() => facets.identity.sessionId),
    prompt: enumerableGetter(() => facets.input.prompt),
    historyMessages: enumerableGetter(() => facets.session.historyMessages),
    toolPermissionMode: enumerableGetter(
      () => facets.lifecycle.toolPermissionMode,
    ),
    ...(facets.lifecycle.toolApprovalController !== undefined
      ? {
          toolApprovalController: enumerableGetter(
            () => facets.lifecycle.toolApprovalController!,
          ),
        }
      : {}),
    onEvent: enumerableGetter(() => facets.lifecycle.onEvent),
    ...(facets.session.contextCompactionStore !== undefined
      ? {
          contextCompactionStore: enumerableGetter(
            () => facets.session.contextCompactionStore!,
          ),
        }
      : {}),
    [BOUND_REQUEST_MODEL_INVOCATION]: hiddenValue(true),
  });
}

export function createCapabilityExecutionView(
  facets: RequestSeedFacets,
  executionPolicySelection: RequestExecutionSeed["executionPolicySelection"],
  modelSteps: RequestModelStepPort,
): RequestCapabilityExecutionView {
  return createFrozenSurface<RequestCapabilityExecutionView>({
    ...requestSeedDescriptors(facets, executionPolicySelection, false),
    modelSteps: enumerableGetter(() => modelSteps),
    [BOUND_REQUEST_MODEL_INVOCATION]: hiddenValue(true),
  });
}

export function createScopeSurface(
  input: Readonly<{
    facets: RequestSeedFacets;
    policy: RequestExecutionPolicyFacet;
    modelInvocation: RequestModelInvocationView;
    modelSteps: RequestModelStepPort;
    capabilities: RequestWorkerCapabilities;
  }>,
): RequestExecutionScope {
  const { facets, policy, modelInvocation, modelSteps, capabilities } = input;
  return createFrozenSurface<RequestExecutionScope>({
    ...requestSeedDescriptors(facets, policy.selection, true),
    ...(facets.session.sessionMemory !== undefined
      ? {
          sessionMemory: enumerableGetter(() => facets.session.sessionMemory!),
        }
      : {}),
    executionPolicy: enumerableGetter(() => policy.executionPolicy),
    modelSteps: enumerableGetter(() => modelSteps),
    workerCapabilities: enumerableGetter(() => capabilities),
    identity: hiddenValue(facets.identity),
    input: hiddenValue(facets.input),
    session: hiddenValue(facets.session),
    model: hiddenValue(facets.model),
    lifecycle: hiddenValue(facets.lifecycle),
    presentation: hiddenValue(facets.presentation),
    policy: hiddenValue(policy),
    modelInvocation: hiddenValue(modelInvocation),
    capabilities: hiddenValue(capabilities),
    [BOUND_REQUEST_MODEL_INVOCATION]: hiddenValue(true),
    [REQUEST_EXECUTION_SCOPE]: hiddenValue(true),
  });
}

function requestSeedDescriptors(
  facets: RequestSeedFacets,
  executionPolicySelection: RequestExecutionSeed["executionPolicySelection"],
  includeSessionArtifactPaths: boolean,
): PropertyDescriptorMap {
  return {
    requestId: enumerableGetter(() => facets.identity.requestId),
    sessionId: enumerableGetter(() => facets.identity.sessionId),
    prompt: enumerableGetter(() => facets.input.prompt),
    ...(facets.input.temporalContext !== undefined
      ? {
          temporalContext: enumerableGetter(
            () => facets.input.temporalContext!,
          ),
        }
      : {}),
    historyMessages: enumerableGetter(() => facets.session.historyMessages),
    ...(includeSessionArtifactPaths &&
    facets.session.sessionArtifactPaths !== undefined
      ? {
          sessionArtifactPaths: enumerableGetter(
            () => facets.session.sessionArtifactPaths!,
          ),
        }
      : {}),
    shouldGenerateSessionTitle: enumerableGetter(
      () => facets.session.shouldGenerateSessionTitle,
    ),
    runnerConfig: enumerableGetter(() => facets.model.runnerConfig),
    ...(executionPolicySelection !== undefined
      ? {
          executionPolicySelection: enumerableGetter(
            () => executionPolicySelection,
          ),
        }
      : {}),
    ...(facets.input.attachments !== undefined
      ? { attachments: enumerableGetter(() => facets.input.attachments!) }
      : {}),
    agentMode: enumerableGetter(() => facets.input.agentMode),
    ...(facets.model.modelPreference !== undefined
      ? {
          modelPreference: enumerableGetter(
            () => facets.model.modelPreference!,
          ),
        }
      : {}),
    ...(facets.model.modelPolicy !== undefined
      ? { modelPolicy: enumerableGetter(() => facets.model.modelPolicy!) }
      : {}),
    modelGatewayClient: enumerableGetter(() => facets.model.modelGatewayClient),
    ...(facets.session.contextCompactionStore !== undefined
      ? {
          contextCompactionStore: enumerableGetter(
            () => facets.session.contextCompactionStore!,
          ),
        }
      : {}),
    ...(facets.lifecycle.requestSteering !== undefined
      ? {
          requestSteering: enumerableGetter(
            () => facets.lifecycle.requestSteering!,
          ),
        }
      : {}),
    toolPermissionMode: enumerableGetter(
      () => facets.lifecycle.toolPermissionMode,
    ),
    ...(facets.lifecycle.toolApprovalController !== undefined
      ? {
          toolApprovalController: enumerableGetter(
            () => facets.lifecycle.toolApprovalController!,
          ),
        }
      : {}),
    abortSignal: enumerableGetter(() => facets.lifecycle.abortSignal),
    onAcknowledgement: enumerableGetter(
      () => facets.presentation.onAcknowledgement,
    ),
    onSessionTitle: enumerableGetter(() => facets.presentation.onSessionTitle),
    onThinkingDelta: enumerableGetter(
      () => facets.presentation.onThinkingDelta,
    ),
    onThinkingTrace: enumerableGetter(
      () => facets.presentation.onThinkingTrace,
    ),
    onAnswerToken: enumerableGetter(() => facets.presentation.onAnswerToken),
    onEvent: enumerableGetter(() => facets.lifecycle.onEvent),
  };
}
