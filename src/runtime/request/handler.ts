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

export async function handleRunRequest(
  ws: WebSocket,
  msg: RunRequestMessage,
  options: RequestHandlerOptions = {},
): Promise<RequestHandlerOutcome> {
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

  async run(): Promise<RequestHandlerOutcome> {
    try {
      return await this.execute();
    } catch (error: unknown) {
      return await this.fail(error);
    } finally {
      await this.dispose();
    }
  }

  private async execute(): Promise<RequestHandlerOutcome> {
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
      ...(this.durable
        ? {
            persistResponse: (message: SessionTerminalMessage) =>
              this.commitTerminal(message, "completed"),
          }
        : {}),
      composeInvalidFinalOutput: () =>
        runModelAuthoredDegradedFinalization({
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
    const cancelled = isRequestCancelled(this.lifecycle.signal);
    const interrupted = isRequestInterrupted(this.lifecycle.signal);
    let message = error instanceof Error ? error.message : "unknown error";
    if (this.lifecycle.timedOutReason) message = this.lifecycle.timedOutReason;
    if (cancelled) message = REQUEST_CANCELLED;
    if (interrupted) message = REQUEST_INTERRUPTED;
    traceDebug("runtime.request", "request.failed", {
      requestId: this.input.requestId,
      sessionId: this.input.sessionId,
      error: message,
    });
    if (this.durable) {
      await this.requestSteering.close();
      const cause = classifyRequestTerminalCause(this.lifecycle.signal);
      const current = await this.durable.finalizeFailure({
        commandId: randomUUID(),
        cause,
        error: message,
        message: createRequestFailureMessage({
          cause,
          partialAnswer: this.callbacks?.getAnswerText() ?? "",
          thinkingTrace: this.callbacks?.getThinkingTrace(),
        }),
      });
      this.finalized = true;
      if (current?.status === "awaiting_approval")
        return { kind: "awaiting_approval", lifecycle: current };
      return;
    }
    const details: Record<string, unknown> = {};
    if (this.lifecycle.timedOutReason) details.stage = "timeout";
    if (cancelled && this.callbacks) {
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
    failRequest({ events: this.events, error: message, details });
    this.finalized = true;
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
