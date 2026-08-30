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
    ...(seed.attachments !== undefined
      ? { attachments: seed.attachments }
      : {}),
    agentMode: seed.agentMode,
  });
  const session = Object.freeze({
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
    runnerConfig: seed.runnerConfig,
    ...(seed.modelPreference !== undefined
      ? { modelPreference: seed.modelPreference }
      : {}),
    ...(seed.modelPolicy !== undefined
      ? { modelPolicy: seed.modelPolicy }
      : {}),
    modelGatewayClient: seed.modelGatewayClient,
  });
  const memory = Object.freeze({
    ...(seed.longTermMemory !== undefined
      ? { longTermMemory: seed.longTermMemory }
      : {}),
  });
  const lifecycle = Object.freeze({
    ...(seed.requestSteering !== undefined
      ? { requestSteering: seed.requestSteering }
      : {}),
    toolPermissionMode: seed.toolPermissionMode,
    ...(seed.toolApprovalController !== undefined
      ? { toolApprovalController: seed.toolApprovalController }
      : {}),
    abortSignal: seed.abortSignal,
    onEvent: seed.onEvent,
  });
  const presentation = Object.freeze({
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
  });
}
