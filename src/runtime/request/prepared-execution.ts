import type WebSocket from "ws";
import type { SessionRequestLifecycleSnapshot } from "../../sessions/request-lifecycle/contracts.js";
import type { ToolRequestAttachment } from "../../capabilities/tool-types.js";
import type { EventSink } from "../ports.js";
import type {
  RequestHandlerOptions,
  RequestExecutionSeed,
} from "./contracts.js";
import type { parseRequestInput } from "./input.js";
import type { resolveRequestDependencies } from "./dependencies.js";
import type { RequestToolResources } from "../capabilities/request-tool-resources.js";
import type { RequestLifecycle } from "../orchestration/lifecycle/request-lifecycle.js";
import type { RequestSteeringInbox } from "./request-steering.js";
import type { RequestTemporalContext } from "../context/request-temporal-context.js";
import { resolveSessionWorkingDirectory } from "../projects/session-paths.js";
import { resolveModelSelection } from "../model/model-selection.js";
import { resolveScheduledExecution } from "./scheduled-execution.js";
import { resolveRequestExecutionPolicy } from "./role-executor-composition.js";
import {
  initializeRequestSession,
  openRequestSession,
} from "../session/request-session.js";
import { snapshotRequestHistory } from "../session/request-history.js";
import {
  createRequestSessionTitleUpdater,
  shouldGenerateSessionTitle,
} from "../session/session-title.js";
import {
  createPersistentRequestEvents,
  createRequestCallbacks,
} from "../streaming/request-callbacks.js";
import { createRequestContextCompactionStore } from "../context/semantic-compaction/index.js";
import { restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { createRequestSessionMemory } from "../context/session-memory/index.js";
import { restoreRequestSessionMemory } from "../context/session-memory/snapshot.js";
import { snapshotSessionArtifactPathTargets } from "./session-artifact-path-persistence.js";
import { createRequestExecutionScope } from "./execution-scope.js";
import { createRequestWorkerCapabilityProvider } from "./worker-capability-composition.js";
import { withToolApprovalWait } from "./tool-approval-wait.js";
import { RequestActivationEvents } from "./approval-wait/activation-events.js";
import { createRequestApprovalGate } from "./approval-wait/approval-gate.js";

export type RequestPreparationInput = Readonly<{
  ws: WebSocket;
  options: RequestHandlerOptions;
  input: ReturnType<typeof parseRequestInput>;
  dependencies: ReturnType<typeof resolveRequestDependencies>;
  resources: RequestToolResources;
  lifecycle: RequestLifecycle;
  steering: RequestSteeringInbox;
  temporalContext: RequestTemporalContext;
  initialEvents: EventSink;
  onEventsReady(
    events: EventSink,
    callbacks: ReturnType<typeof createRequestCallbacks>,
    durable: RequestActivationEvents | undefined,
  ): void;
}>;

export async function prepareRequestExecution(params: RequestPreparationInput) {
  const { options, input, dependencies, resources, lifecycle, steering } =
    params;
  const { requestId, sessionId } = input;
  const { sessionStore, modelGatewayClient, longTermMemory, eventSinkFactory } =
    dependencies;
  const resume = options.approvalExecution?.resume;
  const schedule = resolveScheduledExecution(options, input);
  const loaded = dependencies.loadDecisionEnvironment();
  const selection = resolveModelSelection({
    agentMode: input.rawAgentMode,
    modelPreference: input.rawModelPreference,
    modelPolicy: loaded.modelPolicy,
    ...(loaded.modelExecutionPolicies
      ? { modelExecutionPolicies: loaded.modelExecutionPolicies }
      : {}),
  });
  const executionPolicy = resolveRequestExecutionPolicy(
    resume?.snapshot.seed.executionPolicySelection?.policy ??
      selection.execution.policy,
  );
  const opened = resume
    ? undefined
    : await openRequestSession({
        sessionId,
        requestId,
        rawAttachments: input.rawAttachments,
        sessionStore,
        attachmentStore: dependencies.attachmentStore,
        activation: options.approvalExecution?.activation,
      });
  const durable = createExecutionEvents(params, opened?.activation);
  const events =
    durable?.events ??
    createPersistentRequestEvents({
      currentEvents: params.initialEvents,
      eventSinkFactory,
      requestId,
      sessionId,
      sessionStore,
      ws: params.ws,
    });
  if (durable) params.initialEvents.dispose();
  const callbacks = createRequestCallbacks(
    events,
    resume?.snapshot.presentation,
  );
  params.onEventsReady(events, callbacks, durable);
  const generateSessionTitle =
    resume?.snapshot.seed.shouldGenerateSessionTitle ??
    shouldGenerateSessionTitle(opened!.session);
  const historyMessages =
    resume?.snapshot.seed.historyMessages ??
    snapshotRequestHistory(opened!.session);
  let sessionMemory;
  if (resume?.snapshot.sessionMemory) {
    sessionMemory = restoreRequestSessionMemory(resume.snapshot.sessionMemory, {
      sessionId,
      repository: sessionStore,
      compactor: dependencies.sessionMemoryCompactor,
    });
  } else if (!resume) {
    sessionMemory = createRequestSessionMemory({
      sessionId,
      session: opened!.session,
      repository: sessionStore,
      compactor: dependencies.sessionMemoryCompactor,
    });
  }
  const initialized = resume
    ? undefined
    : await initializeRequestSession({
        opened: opened!,
        sessionId,
        requestId,
        prompt: input.prompt,
        agentMode: selection.agentMode,
        sessionStore,
        attachmentStore: dependencies.attachmentStore,
        events,
        ...(schedule ? { schedule } : {}),
      });
  const requestWorkingDirectory =
    resume?.snapshot.requestWorkingDirectory ??
    resolveSessionWorkingDirectory(opened!.session) ??
    options.runtimeConfig?.paths.agentWorkDir ??
    process.cwd();
  const toolAttachments: readonly ToolRequestAttachment[] =
    resume?.snapshot.toolAttachments ?? initialized!.toolAttachments;
  if (resume) resources.restore(resume.snapshot.resources);
  let controller = dependencies.toolApprovalController;
  if (controller && !options.approvalExecution) {
    controller = withToolApprovalWait(controller, lifecycle);
  }
  const modelAttachments =
    resume?.snapshot.seed.attachments ?? initialized?.modelAttachments;
  const memoryRecallLimit =
    options.runtimeConfig?.longTermMemory?.maxRecallCallsPerRequest;
  const baseSeed = resume?.snapshot.seed ?? {
    requestId,
    sessionId,
    prompt: initialized!.prompt,
    temporalContext: params.temporalContext,
    historyMessages,
    shouldGenerateSessionTitle: generateSessionTitle,
    runnerConfig: loaded.runnerConfig,
    executionPolicySelection: selection.execution,
    ...(modelAttachments?.length ? { attachments: modelAttachments } : {}),
    agentMode: selection.agentMode,
    ...(selection.modelPreference
      ? { modelPreference: selection.modelPreference }
      : {}),
    ...(selection.modelPolicy ? { modelPolicy: selection.modelPolicy } : {}),
    toolPermissionMode: input.toolPermissionMode,
    sessionArtifactPaths: snapshotSessionArtifactPathTargets(
      opened!.session.artifactPaths,
    ),
    ...(memoryRecallLimit !== undefined ? { memoryRecallLimit } : {}),
  };
  const seed: RequestExecutionSeed = {
    ...baseSeed,
    ...(schedule ? { scheduledExecution: schedule } : {}),
    toolResources: resources,
    modelGatewayClient,
    longTermMemory,
    requestSteering: steering,
    sessionMemory,
    contextCompactionStore: resume
      ? restoreRequestContextCompaction(resume.snapshot.compaction)
      : createRequestContextCompactionStore(),
    ...(controller ? { toolApprovalController: controller } : {}),
    ...(options.approvalExecution
      ? {
          modelInvocationScope:
            options.approvalExecution.activation.activationId,
          approvalGate: createRequestApprovalGate({
            resources,
            controller,
            signal: lifecycle.signal,
            onEvent: (name, payload) => {
              events.event(name, payload);
            },
          }),
        }
      : {}),
    abortSignal: lifecycle.signal,
    onAcknowledgement: callbacks.onAcknowledgement,
    onSessionTitle: createRequestSessionTitleUpdater({
      shouldGenerateTitle: generateSessionTitle,
      sessionId,
      requestId,
      sessionStore,
      events,
      abortSignal: lifecycle.signal,
    }),
    onThinkingDelta: callbacks.onThinkingDelta,
    onThinkingTrace: callbacks.onThinkingTrace,
    onAnswerToken: callbacks.onAnswerToken,
    onEvent: (name, extra) => {
      events.event(name, extra);
    },
  };
  const toolRegistry = options.toolRegistry?.prepareRequest
    ? await options.toolRegistry.prepareRequest({
        requestState: resources.state,
        onRequestDispose: resources.onRequestDispose,
      })
    : options.toolRegistry;
  lifecycle.signal.throwIfAborted();
  resources.assertRestoredStateClaimed();
  const request = createRequestExecutionScope({
    seed,
    executionPolicy,
    createWorkerCapabilities: (view) =>
      createRequestWorkerCapabilityProvider({
        request: view,
        requestWorkingDirectory,
        executionPolicyAuthority: executionPolicy.authority,
        requestAttachments: toolAttachments,
        ...(options.runtimeConfig
          ? { runtimeConfig: options.runtimeConfig }
          : {}),
        ...(toolRegistry ? { toolRegistryOverride: toolRegistry } : {}),
      }),
  });
  return {
    request,
    seed,
    events,
    callbacks,
    durable,
    requestWorkingDirectory,
    toolAttachments,
  };
}

function createExecutionEvents(
  params: RequestPreparationInput,
  openedActivation: SessionRequestLifecycleSnapshot | undefined,
): RequestActivationEvents | undefined {
  const options = params.options.approvalExecution;
  if (!options) return undefined;
  const store = params.dependencies.sessionStore.requestLifecycle;
  if (!store) throw new Error("durable_approval_store_unavailable");
  const current = options.resume?.current ?? openedActivation;
  if (!current) throw new Error("request_activation_missing");
  return new RequestActivationEvents(
    store,
    current,
    params.dependencies.eventSinkFactory,
    params.ws,
  );
}
