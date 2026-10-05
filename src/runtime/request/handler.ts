import { hasSuperContextContract } from "../context/super-context-policy.js";
import { TerminalResponseAppend } from "../session/terminal-response.js";
import { boundedSuperFailureCode } from "../steps/degraded-finalization/super.js";
import type { SuperFailureFinalization } from "./super-failure-explanation.js";
import { composeSuperFailureMessage } from "./super-failure-message.js";
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { isRequestCancelled, REQUEST_CANCELLED } from "./cancellation.js";
import { isRequestInterrupted, REQUEST_INTERRUPTED } from "./interruption.js";
import { RequestToolResources } from "../capabilities/request-tool-resources.js";
import { traceDebug } from "../observability/debug-logger.js";
import { RequestLifecycle } from "../orchestration/lifecycle/request-lifecycle.js";
import { ROLE_CALL_RESPONSE_MAX_LENGTH } from "../orchestration/role-calls/index.js";
import { runModelAuthoredDegradedFinalization } from "../steps/degraded-finalization/model-authored.js";
import type { RequestHandlerOptions, RunRequestMessage } from "./contracts.js";
import { captureRequestTemporalContext } from "../context/request-temporal-context.js";
import {
  failRequest,
  finalizeRequest,
} from "../lifecycle/request-finalizer.js";
import { resolveRequestDependencies } from "./dependencies.js";
import { parseRequestInput } from "./input.js";
import { runRequestRunner } from "./runner.js";
import type { RequestCompletionDisposition } from "./result.js";
import { persistCancelledResponse } from "../session/cancelled-response.js";
import {
  createInitialRequestEvents,
  createRequestCallbacks,
} from "../streaming/request-callbacks.js";
import { createRequestSteeringInbox } from "./request-steering.js";
import { prepareRequestExecution } from "./prepared-execution.js";
import type { RequestActivationEvents } from "./approval-wait/activation-events.js";
import { parkRequestApproval } from "./approval-wait/park.js";
import {
  classifyRequestTerminalCause,
  createRequestFailureMessage,
} from "./approval-wait/failure.js";
import type {
  SessionRequestLifecycleSnapshot,
  SessionTerminalMessage,
} from "../../sessions/request-lifecycle/contracts.js";

export type RequestHandlerOutcome = void | Readonly<{
  kind: "awaiting_approval";
  lifecycle: SessionRequestLifecycleSnapshot;
}>;

export type InternalRequestHandlerOutcome =
  | RequestHandlerOutcome
  | Readonly<{
      kind: "completed";
      disposition: RequestCompletionDisposition;
    }>;

export async function handleRunRequest(
  ws: WebSocket,
  msg: RunRequestMessage,
  options: RequestHandlerOptions = {},
): Promise<RequestHandlerOutcome> {
  const outcome = await handleRunRequestWithOutcome(ws, msg, options);
  if (!outcome) return;
  const hasPendingApproval = outcome.kind === "awaiting_approval";
  if (hasPendingApproval) return outcome;
}

/** In-process terminal metadata; the ordinary handler preserves its public return shape. */
export async function handleRunRequestWithOutcome(
  ws: WebSocket,
  msg: RunRequestMessage,
  options: RequestHandlerOptions = {},
): Promise<InternalRequestHandlerOutcome> {
  return new RequestHandlingSession(ws, msg, options).run();
}

/** One active invocation. A saved approval boundary retires this entire object. */
class RequestHandlingSession {
  private readonly toolResources = new RequestToolResources();
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
  private callbacks?: ReturnType<typeof createRequestCallbacks>;
  private durable?: RequestActivationEvents;
  private steeringPersistenceError: unknown;
  private finalized = false;
  private superFailurePolicy = false;
  private superFailureFinalization?: SuperFailureFinalization;
  private terminalResponse?: TerminalResponseAppend;

  constructor(
    private readonly ws: WebSocket,
    msg: RunRequestMessage,
    private readonly options: RequestHandlerOptions,
  ) {
    this.input = parseRequestInput(msg);
    const restored = options.approvalExecution?.resume?.snapshot;
    this.temporalContext =
      restored?.seed.temporalContext ?? captureRequestTemporalContext();
    this.requestSteering =
      options.requestSteering ??
      createRequestSteeringInbox({ requestId: this.input.requestId });
    for (const update of restored?.steering.updates ?? []) {
      const result = this.requestSteering.append(update);
      if (!result.ok || result.update.sequence !== update.sequence) {
        throw new Error("request_steering_restore_mismatch");
      }
    }
    this.dependencies = resolveRequestDependencies(options);
    this.lifecycle = new RequestLifecycle({
      requestId: this.input.requestId,
      abortSignal: options.abortSignal,
      ...(restored ? { budgets: restored.budgets } : {}),
    });
    this.lifecycle.signal.addEventListener(
      "abort",
      () => {
        void this.toolResources.dispose();
      },
      { once: true },
    );
    this.events = createInitialRequestEvents({
      eventSinkFactory: this.dependencies.eventSinkFactory,
      requestId: this.input.requestId,
      ws,
    });
  }

  async run(): Promise<InternalRequestHandlerOutcome> {
    try {
      return await this.execute();
    } catch (error: unknown) {
      try {
        return await this.fail(error);
      } catch (secondary: unknown) {
        if (
          this.terminalResponse?.failureOutcome(secondary) === "session_deleted"
        )
          return this.fail(secondary);
        if (this.superFailurePolicy)
          traceDebug("runtime.request", "super.failure_delivery_rejected", {
            requestId: this.input.requestId,
            primaryCode: boundedSuperFailureCode(
              this.superFailureFinalization?.primaryError() ?? error,
            ),
            secondaryCode: boundedSuperFailureCode(secondary),
          });
        throw secondary;
      }
    } finally {
      await this.dispose();
    }
  }

  private async execute(): Promise<InternalRequestHandlerOutcome> {
    const prepared = await prepareRequestExecution({
      ws: this.ws,
      options: this.options,
      input: this.input,
      dependencies: this.dependencies,
      resources: this.toolResources,
      lifecycle: this.lifecycle,
      steering: this.requestSteering,
      temporalContext: this.temporalContext,
      initialEvents: this.events,
      onFailurePolicyReady: (policy) => {
        this.superFailurePolicy = hasSuperContextContract(
          policy.authority,
          policy.rootContract.contractId,
        );
      },
      onSessionAdmitted: (agentMode) => {
        if (!this.superFailurePolicy || this.durable) return;
        this.terminalResponse = new TerminalResponseAppend({
          store: this.dependencies.sessionStore,
          sessionId: this.input.sessionId,
          requestId: this.input.requestId,
          agentMode,
        });
      },
      onFailureFinalizationReady: (finalization) => {
        this.superFailureFinalization = finalization;
      },
      onEventsReady: (events, callbacks, durable) => {
        this.events = events;
        this.callbacks = callbacks;
        this.durable = durable;
      },
    });
    this.bindSteeringPersistence();
    this.lifecycle.signal.throwIfAborted();
    this.lifecycle.updateState({ stage: "model" });
    this.events.runtimeState({ stage: "model" });
    const store = this.dependencies.sessionStore;
    const upsertArtifactPaths = store.upsertArtifactPaths?.bind(store);
    const persistArtifactPaths = upsertArtifactPaths
      ? async (inputs: Parameters<typeof upsertArtifactPaths>[1]) => {
          await upsertArtifactPaths(this.input.sessionId, inputs);
        }
      : undefined;
    let result;
    if (this.durable) {
      const resume = this.options.approvalExecution?.resume;
      const outcome = await runRequestRunner(prepared.request, {
        durableApproval: true,
        persistArtifactPaths,
        ...(resume
          ? {
              continuation: resume.snapshot.runner,
              decisions: resume.decisions,
            }
          : {}),
      });
      if (outcome.kind === "awaiting_approval") {
        await this.requestSteering.close();
        if (this.steeringPersistenceError) throw this.steeringPersistenceError;
        const current = await parkRequestApproval({
          prepared,
          continuation: outcome.continuation,
          originalPrompt: resume?.snapshot.originalPrompt ?? this.input.prompt,
          resources: this.toolResources,
          steering: this.requestSteering,
          lifecycle: this.lifecycle,
          store: store.requestLifecycle!,
        });
        this.finalized = true;
        return { kind: "awaiting_approval", lifecycle: current };
      }
      result = outcome.result;
    } else {
      result = await runRequestRunner(prepared.request, {
        persistArtifactPaths,
      });
    }
    if (this.lifecycle.timedOutReason !== null)
      throw new Error(this.lifecycle.timedOutReason);
    await finalizeRequest({
      rawOutput: result.output,
      outputTextMode: result.outputTextMode,
      events: this.events,
      lifecycle: this.lifecycle,
      claimFinalization: this.options.claimFinalization,
      sessionStore: store,
      sessionId: this.input.sessionId,
      requestId: this.input.requestId,
      agentMode: prepared.seed.agentMode,
      thinkingTrace: prepared.callbacks.getThinkingTrace(),
      finalObservation: result.finalObservation,
      memoryCandidates: result.memoryCandidates,
      longTermMemory: this.dependencies.longTermMemory,
      ...this.terminalResponsePersister(),
      composeInvalidFinalOutput: () =>
        this.superFailureFinalization
          ? this.superFailureFinalization
              .explain({
                error: new Error("invalid_final_output"),
                input: {
                  problem: {
                    code: "invalid_final_output",
                    stage: "chat_finalization",
                  },
                  progress: null,
                },
                maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
              })
              .then(({ output }) => output)
          : runModelAuthoredDegradedFinalization({
              request: prepared.request,
              input: {
                problem: {
                  code: "invalid_final_output",
                  stage: "chat_finalization",
                },
                progress: null,
              },
              maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
            }),
    });
    this.finalized = true;
    return {
      kind: "completed",
      disposition: result.disposition ?? "responded",
    };
  }

  private terminalResponsePersister(): {
    persistResponse?: (message: SessionTerminalMessage) => Promise<void>;
  } {
    if (this.durable)
      return {
        persistResponse: (message) => this.commitTerminal(message, "completed"),
      };
    if (this.terminalResponse)
      return {
        persistResponse: (message) => this.appendTerminalResponse(message),
      };
    return {};
  }

  private async appendTerminalResponse(
    message: SessionTerminalMessage,
  ): Promise<void> {
    try {
      await this.terminalResponse!.append(message);
    } catch (error: unknown) {
      traceDebug("runtime.request", "super.terminal_append_failed", {
        requestId: this.input.requestId,
        primaryCode: boundedSuperFailureCode(
          this.superFailureFinalization?.primaryError() ?? error,
        ),
        secondaryCode: boundedSuperFailureCode(error),
        persisted: false,
        persistence: this.terminalResponse!.failureOutcome(error),
      });
      throw error;
    }
  }

  private bindSteeringPersistence(): void {
    const persistedPrefix =
      this.options.approvalExecution?.resume?.snapshot.steering.version ?? 0;
    this.requestSteering.bindPersistence(async (update) => {
      if (update.sequence <= persistedPrefix) return;
      try {
        await this.dependencies.sessionStore.appendMessage(
          this.input.sessionId,
          "user",
          update.text,
          {
            source: "user",
            requestId: this.input.requestId,
          },
        );
        this.events.event("session.messages.updated", {
          sessionId: this.input.sessionId,
        });
      } catch (error) {
        this.steeringPersistenceError ??= error;
        throw error;
      }
    });
  }

  private async commitTerminal(
    message: SessionTerminalMessage,
    status: "completed" | "failed",
  ): Promise<void> {
    const store = this.dependencies.sessionStore.requestLifecycle!;
    await this.durable!.commit((expected) =>
      store.commitTerminal(this.input.sessionId, {
        expected,
        commandId: randomUUID(),
        status,
        message,
      }),
    );
    this.finalized = true;
  }

  private async fail(error: unknown): Promise<RequestHandlerOutcome> {
    if (this.finalized) return;
    const append = this.terminalResponse?.snapshot();
    if (append?.attempted) {
      traceDebug("runtime.request", "super.terminal_delivery_failed", {
        requestId: this.input.requestId,
        primaryCode: boundedSuperFailureCode(
          this.superFailureFinalization?.primaryError() ?? error,
        ),
        secondaryCode: boundedSuperFailureCode(error),
        persisted: append.persisted,
      });
      const outcome = this.terminalResponse!.failureOutcome(error);
      if (outcome === "uncertain") throw error;
      this.finalized = true;
      if (outcome === "session_deleted")
        failRequest({ events: this.events, error: this.failureCode(error) });
      return;
    }
    const primary = this.superFailureFinalization?.primaryError() ?? error;
    const message = this.failureCode(primary);
    traceDebug("runtime.request", "request.failed", {
      requestId: this.input.requestId,
      sessionId: this.input.sessionId,
      error: message,
      ...(primary !== error
        ? { secondaryCode: boundedSuperFailureCode(error) }
        : {}),
    });
    if (this.durable) {
      if (!this.superFailurePolicy) await this.requestSteering.close();
      const current = await this.durable.finalizeFailure({
        commandId: randomUUID(),
        cause: classifyRequestTerminalCause(this.lifecycle.signal),
        error: message,
        message: this.ordinaryFailureMessage(),
        ...(this.superFailurePolicy
          ? {
              prepareFailure: async () => ({
                message: await this.prepareSuperFailureMessage(primary),
                cause: classifyRequestTerminalCause(this.lifecycle.signal),
                error: this.failureCode(primary),
              }),
            }
          : {}),
      });
      await this.requestSteering.close();
      this.finalized = true;
      if (current?.status === "awaiting_approval")
        return { kind: "awaiting_approval", lifecycle: current };
      return;
    }
    const details: Record<string, unknown> = {};
    if (this.lifecycle.timedOutReason) details.stage = "timeout";
    if (this.canPersistSuperFailure()) {
      const terminalMessage = await this.prepareSuperFailureMessage(primary);
      if (this.canPersistSuperFailure()) {
        this.options.claimFinalization?.();
        await this.appendTerminalResponse(terminalMessage);
        this.finalized = true;
        failRequest({
          events: this.events,
          error: this.failureCode(primary),
          details: { ...details, stoppedResponse: terminalMessage.content },
        });
        return;
      }
    }
    if (isRequestCancelled(this.lifecycle.signal) && this.callbacks) {
      await this.requestSteering.close();
      Object.assign(
        details,
        await persistCancelledResponse({
          sessionStore: this.dependencies.sessionStore,
          sessionId: this.input.sessionId,
          requestId: this.input.requestId,
          partialAnswer: this.callbacks.getAnswerText(),
          thinkingTrace: this.callbacks.getThinkingTrace(),
        }),
      );
    }
    failRequest({
      events: this.events,
      error: this.failureCode(primary),
      details,
    });
    this.finalized = true;
  }

  private canPersistSuperFailure(): boolean {
    if (!this.superFailurePolicy) return false;
    if (!this.durable && !this.terminalResponse) return false;
    if (isRequestCancelled(this.lifecycle.signal)) return false;
    return !isRequestInterrupted(this.lifecycle.signal);
  }

  private failureCode(error: unknown): string {
    if (isRequestCancelled(this.lifecycle.signal)) return REQUEST_CANCELLED;
    if (isRequestInterrupted(this.lifecycle.signal)) return REQUEST_INTERRUPTED;
    if (this.lifecycle.timedOutReason) return this.lifecycle.timedOutReason;
    return error instanceof Error ? error.message : "unknown error";
  }

  private ordinaryFailureMessage(): SessionTerminalMessage {
    return createRequestFailureMessage({
      cause: classifyRequestTerminalCause(this.lifecycle.signal),
      partialAnswer: this.callbacks?.getAnswerText() ?? "",
      thinkingTrace: this.callbacks?.getThinkingTrace(),
    });
  }

  private async prepareSuperFailureMessage(
    error: unknown,
  ): Promise<SessionTerminalMessage> {
    if (!this.canPersistSuperFailure()) {
      await this.requestSteering.close();
      return this.ordinaryFailureMessage();
    }
    const message = await composeSuperFailureMessage({
      requestId: this.input.requestId,
      error,
      finalization: this.superFailureFinalization,
      steering: this.requestSteering,
    });
    if (!this.canPersistSuperFailure()) return this.ordinaryFailureMessage();
    return message;
  }

  private async dispose(): Promise<void> {
    try {
      await this.toolResources.dispose();
      await this.requestSteering.close();
      if (!this.finalized || !this.durable) await this.events.drain();
    } finally {
      this.events.dispose();
      this.lifecycle.dispose();
    }
  }
}
