import type {
  AcceptedRequestInput,
  RequestSessionSnapshot,
  RequestExecutionSeed,
  RequestIdentity,
  RequestLifecycleRuntime,
  RequestModelInvocationView,
  RequestModelRuntime,
  RequestMemoryRuntime,
  RequestPresentation,
} from "./contracts.js";
import { createFrozenSurface, enumerableGetter } from "./immutable-view.js";

export type RequestSeedFacets = Readonly<{
  identity: RequestIdentity;
  input: AcceptedRequestInput;
  session: RequestSessionSnapshot;
  model: RequestModelRuntime;
  memory: RequestMemoryRuntime;
  lifecycle: RequestLifecycleRuntime;
  presentation: RequestPresentation;
}>;

export function createRequestSeedFacets(
  seed: RequestExecutionSeed,
): RequestSeedFacets {
  const identity = Object.freeze({
    requestId: seed.requestId,
    sessionId: seed.sessionId,
  });
  const input = Object.freeze({
    prompt: seed.prompt,
    ...(seed.temporalContext !== undefined
      ? { temporalContext: seed.temporalContext }
      : {}),
    ...(seed.scheduledExecution !== undefined
      ? { scheduledExecution: seed.scheduledExecution }
      : {}),
    ...(seed.attachments !== undefined
      ? { attachments: seed.attachments }
      : {}),
    agentMode: seed.agentMode,
    ...(seed.automationOutputContract !== undefined
      ? { automationOutputContract: seed.automationOutputContract }
      : {}),
  });
  const session = Object.freeze({
    ...(seed.sessionKind ? { sessionKind: seed.sessionKind } : {}),
    historyMessages: seed.historyMessages,
    ...(seed.sessionArtifactPaths !== undefined
      ? { sessionArtifactPaths: seed.sessionArtifactPaths }
      : {}),
    shouldGenerateSessionTitle: seed.shouldGenerateSessionTitle,
    ...(seed.contextCompactionStore !== undefined
      ? { contextCompactionStore: seed.contextCompactionStore }
      : {}),
    ...(seed.sessionMemory !== undefined
      ? { sessionMemory: seed.sessionMemory }
      : {}),
  });
  const model = Object.freeze({
    ...(seed.toolResources ? { toolResources: seed.toolResources } : {}),
    ...(seed.modelInvocationScope !== undefined
      ? { modelInvocationScope: seed.modelInvocationScope }
      : {}),
    runnerConfig: seed.runnerConfig,
    ...(seed.reasoningPreference ? { reasoningPreference: seed.reasoningPreference } : {}),
    ...(seed.modelPreference !== undefined
      ? { modelPreference: seed.modelPreference }
      : {}),
    ...(seed.modelPolicy !== undefined
      ? { modelPolicy: seed.modelPolicy }
      : {}),
    modelGatewayClient: seed.modelGatewayClient,
  });
  const memory = Object.freeze({
    ...(seed.memoryRecallLimit !== undefined
      ? { memoryRecallLimit: seed.memoryRecallLimit }
      : {}),
    ...(seed.longTermMemory !== undefined
      ? { longTermMemory: seed.longTermMemory }
      : {}),
  });
  const lifecycle = Object.freeze({
    ...(seed.approvalGate ? { approvalGate: seed.approvalGate } : {}),
    ...(seed.requestSteering !== undefined
      ? { requestSteering: seed.requestSteering }
      : {}),
    ...(seed.effectPersistence !== undefined
      ? { effectPersistence: seed.effectPersistence }
      : {}),
    toolPermissionMode: seed.toolPermissionMode,
    ...(seed.toolApprovalController !== undefined
      ? { toolApprovalController: seed.toolApprovalController }
      : {}),
    abortSignal: seed.abortSignal,
    onEvent: seed.onEvent,
  });
  const presentation = Object.freeze({
    ...(seed.userInteractions ? { userInteractions: seed.userInteractions } : {}),
    onAcknowledgement: seed.onAcknowledgement,
    onSessionTitle: seed.onSessionTitle,
    onThinkingDelta: seed.onThinkingDelta,
    onThinkingTrace: seed.onThinkingTrace,
    onAnswerToken: seed.onAnswerToken,
  });
  return Object.freeze({
    identity,
    input,
    session,
    model,
    memory,
    lifecycle,
    presentation,
  });
}

export function createModelInvocationView(
  facets: RequestSeedFacets,
): RequestModelInvocationView {
  return createFrozenSurface<RequestModelInvocationView>({
    ...(facets.model.modelInvocationScope !== undefined
      ? {
          modelInvocationScope: enumerableGetter(
            () => facets.model.modelInvocationScope!,
          ),
        }
      : {}),
    ...(facets.model.toolResources
      ? { toolResources: enumerableGetter(() => facets.model.toolResources!) }
      : {}),
    requestId: enumerableGetter(() => facets.identity.requestId),
    runnerConfig: enumerableGetter(() => facets.model.runnerConfig),
    agentMode: enumerableGetter(() => facets.input.agentMode),
    ...(facets.model.reasoningPreference ? { reasoningPreference: enumerableGetter(() => facets.model.reasoningPreference!) } : {}),
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
  });
}
