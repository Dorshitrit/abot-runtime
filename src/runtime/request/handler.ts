import type WebSocket from "ws";

import { traceDebug } from "../observability/debug-logger.js";
import { RequestLifecycle } from "../orchestration/lifecycle/request-lifecycle.js";
import type {
  RequestHandlerOptions,
  RequestExecutionSeed,
  RunRequestMessage,
} from "./contracts.js";
import { createRequestContextCompactionStore } from "../context/semantic-compaction/index.js";
import { captureRequestTemporalContext } from "../context/request-temporal-context.js";
import {
  failRequest,
  finalizeRequest,
} from "../lifecycle/request-finalizer.js";
import { resolveModelSelection } from "../model/model-selection.js";
import { resolveRequestDependencies } from "./dependencies.js";
import { parseRequestInput } from "./input.js";
import { runRequestRunner } from "./runner.js";
import { createRequestWorkerCapabilityProvider } from "./worker-capability-composition.js";
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
  createInitialRequestEvents,
  createRequestCallbacks,
  createPersistentRequestEvents,
} from "../streaming/request-callbacks.js";
import { createRequestSteeringInbox } from "./request-steering.js";
import { snapshotSessionArtifactPathTargets } from "./session-artifact-path-persistence.js";
import { createRequestExecutionScope } from "./execution-scope.js";
import { createRequestSessionMemory } from "../context/session-memory/index.js";

export async function handleRunRequest(
  ws: WebSocket,
  msg: RunRequestMessage,
  options: RequestHandlerOptions = {},
): Promise<void> {
  return new RequestHandlingSession(ws, msg, options).run();
}

/** Owns the lifecycle and mutable edge state of one accepted request. */
class RequestHandlingSession {
  private readonly input: ReturnType<typeof parseRequestInput>;
  private readonly temporalContext: ReturnType<
    typeof captureRequestTemporalContext
  >;
  private readonly requestSteering: ReturnType<
    typeof createRequestSteeringInbox
  >;
  private readonly dependencies: ReturnType<typeof resolveRequestDependencies>;
  private readonly lifecycle: RequestLifecycle;
  private events: ReturnType<typeof createInitialRequestEvents>;
  private finalized = false;

  constructor(
    private readonly ws: WebSocket,
    msg: RunRequestMessage,
    private readonly options: RequestHandlerOptions,
  ) {
    this.input = parseRequestInput(msg);
    this.temporalContext = captureRequestTemporalContext();
    this.requestSteering =
      options.requestSteering ??
      createRequestSteeringInbox({ requestId: this.input.requestId });
    this.dependencies = resolveRequestDependencies(options);
    this.lifecycle = new RequestLifecycle({
      requestId: this.input.requestId,
    });
    this.events = createInitialRequestEvents({
      eventSinkFactory: this.dependencies.eventSinkFactory,
      requestId: this.input.requestId,
      ws,
    });
  }

  async run(): Promise<void> {
    try {
      await this.execute();
    } catch (error: unknown) {
      this.fail(error);
    } finally {
      await this.dispose();
    }
  }

  private async execute(): Promise<void> {
    const {
      requestId,
      sessionId,
      prompt,
      rawAttachments,
      rawAgentMode,
      rawModelPreference,
      toolPermissionMode,
    } = this.input;
    const {
      eventSinkFactory,
      modelGatewayClient,
      sessionStore,
      attachmentStore,
      loadDecisionEnvironment,
      toolApprovalController,
      sessionMemoryCompactor,
      longTermMemory,
    } = this.dependencies;
    const { runnerConfig, modelPolicy, modelExecutionPolicies } =
      loadDecisionEnvironment();
    const modelSelection = resolveModelSelection({
      agentMode: rawAgentMode,
      modelPreference: rawModelPreference,
      modelPolicy,
      ...(modelExecutionPolicies ? { modelExecutionPolicies } : {}),
    });
    const executionPolicy = resolveRequestExecutionPolicy(
      modelSelection.execution.policy,
    );
    const openedSession = await openRequestSession({
      sessionId,
      requestId,
      rawAttachments,
      sessionStore,
      attachmentStore,
    });
    const historyMessages = snapshotRequestHistory(openedSession.session);
    const sessionMemory = createRequestSessionMemory({
      sessionId,
      session: openedSession.session,
      repository: sessionStore,
      compactor: sessionMemoryCompactor,
    });
    const generateSessionTitle = shouldGenerateSessionTitle(
      openedSession.session,
    );

    this.events = createPersistentRequestEvents({
      currentEvents: this.events,
      eventSinkFactory,
      requestId,
      sessionId,
      sessionStore,
      ws: this.ws,
    });

    const callbacks = createRequestCallbacks(this.events);
    const onSessionTitle = createRequestSessionTitleUpdater({
      shouldGenerateTitle: generateSessionTitle,
      sessionId,
      requestId,
      sessionStore,
      events: this.events,
      abortSignal: this.lifecycle.signal,
    });
    const initializedRequest = await initializeRequestSession({
      opened: openedSession,
      sessionId,
      requestId,
      prompt,
      agentMode: modelSelection.agentMode,
      sessionStore,
      attachmentStore,
      events: this.events,
    });
    this.bindSteeringPersistence();
    this.enterModelStage();

    const sessionArtifactPaths = snapshotSessionArtifactPathTargets(
      openedSession.session.artifactPaths,
    );
    const runnerRequestSeed = {
      requestId,
      sessionId,
      prompt: initializedRequest.prompt,
      temporalContext: this.temporalContext,
      historyMessages,
      shouldGenerateSessionTitle: generateSessionTitle,
      runnerConfig,
      executionPolicySelection: modelSelection.execution,
      ...(initializedRequest.modelAttachments.length > 0
        ? { attachments: initializedRequest.modelAttachments }
        : {}),
      agentMode: modelSelection.agentMode,
      ...(modelSelection.modelPreference
        ? { modelPreference: modelSelection.modelPreference }
        : {}),
      ...(modelSelection.modelPolicy
        ? { modelPolicy: modelSelection.modelPolicy }
        : {}),
      modelGatewayClient,
      contextCompactionStore: createRequestContextCompactionStore(),
      sessionMemory,
      longTermMemory,
      requestSteering: this.requestSteering,
      toolPermissionMode,
      ...(toolApprovalController ? { toolApprovalController } : {}),
      abortSignal: this.lifecycle.signal,
      onAcknowledgement: callbacks.onAcknowledgement,
      onSessionTitle,
      onThinkingDelta: callbacks.onThinkingDelta,
      onThinkingTrace: callbacks.onThinkingTrace,
      onAnswerToken: callbacks.onAnswerToken,
      onEvent: (name: string, extra?: Record<string, unknown>) =>
        this.events.event(name, extra),
      ...(sessionArtifactPaths.length > 0 ? { sessionArtifactPaths } : {}),
    } satisfies RequestExecutionSeed;
    const runnerRequest = createRequestExecutionScope({
      seed: runnerRequestSeed,
      executionPolicy,
      createWorkerCapabilities: (request) =>
        createRequestWorkerCapabilityProvider({
          request,
          executionPolicyAuthority: executionPolicy.authority,
          requestAttachments: initializedRequest.toolAttachments,
          ...(this.options.runtimeConfig
            ? { runtimeConfig: this.options.runtimeConfig }
            : {}),
          ...(this.options.toolRegistry
            ? { toolRegistryOverride: this.options.toolRegistry }
            : {}),
        }),
    });
    const upsertArtifactPaths =
      sessionStore.upsertArtifactPaths?.bind(sessionStore);
    const runnerResult = await runRequestRunner(runnerRequest, {
      ...(upsertArtifactPaths
        ? {
            persistArtifactPaths: async (inputs) => {
              await upsertArtifactPaths(sessionId, inputs);
            },
          }
        : {}),
    });

    if (this.lifecycle.timedOutReason !== null) {
      throw new Error(this.lifecycle.timedOutReason);
    }

    const finalization = await finalizeRequest({
      rawOutput: runnerResult.output,
      ...(runnerResult.outputTextMode
        ? { outputTextMode: runnerResult.outputTextMode }
        : {}),
      events: this.events,
      lifecycle: this.lifecycle,
      sessionStore,
      sessionId,
      requestId,
      agentMode: modelSelection.agentMode,
      thinkingTrace: callbacks.getThinkingTrace(),
      finalObservation: runnerResult.finalObservation,
      memoryCandidates: runnerResult.memoryCandidates,
      longTermMemory,
    });
    this.finalized = true;
    if (finalization.status === "failed") return;

    traceDebug("runtime.request", "request.completed", {
      requestId,
      sessionId,
      outputLength: finalization.output.length,
    });
  }

  private bindSteeringPersistence(): void {
    const { requestId, sessionId } = this.input;
    const { sessionStore } = this.dependencies;
    this.requestSteering.bindPersistence((update) =>
      sessionStore
        .appendMessage(sessionId, "user", update.text, {
          source: "user",
          requestId,
        })
        .then(() => undefined),
    );
  }

  private enterModelStage(): void {
    const modelState = { stage: "model" };
    this.lifecycle.updateState(modelState);
    this.events.runtimeState(modelState);
  }

  private fail(error: unknown): void {
    const { requestId, sessionId } = this.input;
    const timedOutReason = this.lifecycle.timedOutReason;
    const message =
      timedOutReason ??
      (error instanceof Error ? error.message : "unknown error");

    traceDebug("runtime.request", "request.failed", {
      requestId,
      sessionId,
      error: message,
    });
    if (this.finalized) return;

    failRequest({
      events: this.events,
      error: message,
      ...(timedOutReason ? { details: { stage: "timeout" } } : {}),
    });
    this.finalized = true;
  }

  private async dispose(): Promise<void> {
    await this.requestSteering.close();
    await this.events.drain();
    this.events.dispose();
    this.lifecycle.dispose();
  }
}
