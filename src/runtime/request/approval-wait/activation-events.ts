import type WebSocket from "ws";
import type {
  SessionActivationExpectation,
  SessionLifecycleMutationResult,
  SessionRequestLifecycleSnapshot,
  SessionRequestLifecycleStore,
  SessionRequestTerminalCause,
  SessionTerminalMessage,
} from "../../../sessions/request-lifecycle/contracts.js";
import type { EventSink, EventSinkFactory } from "../../ports.js";
import { traceDebug } from "../../observability/debug-logger.js";

type AcceptedMutation = Extract<
  SessionLifecycleMutationResult,
  { accepted: true }
>;

/** Execution events and lifecycle transitions share the canonical session queue. */
export class RequestActivationEvents {
  readonly events: EventSink;
  private tail: Promise<void> = Promise.resolve();
  private persistenceError: unknown;
  private sealed = false;

  constructor(
    private readonly store: SessionRequestLifecycleStore,
    private current: SessionRequestLifecycleSnapshot,
    factory: EventSinkFactory,
    private readonly ws: WebSocket,
  ) {
    const transport = {
      send: (data: string) => this.enqueue(JSON.parse(data)),
    } as WebSocket;
    const base = factory.create({
      requestId: current.requestId,
      ws: transport,
    });
    this.events = {
      publish: (payload) => base.publish(payload),
      event: (name, extra) => base.event(name, extra),
      runtimeState: (state) => base.runtimeState(state),
      token: (token) => base.token(token),
      legacyToken: (text) => base.legacyToken(text),
      thinkingDelta: (delta, accumulated) =>
        base.thinkingDelta(delta, accumulated),
      completed: (output) => base.completed(output),
      failed: (error, details) => base.failed(error, details),
      drain: async () => {
        await base.drain();
        await this.tail;
        if (this.persistenceError) throw this.persistenceError;
      },
      dispose: () => {
        this.sealed = true;
        base.dispose();
      },
    };
  }

  snapshot(): SessionRequestLifecycleSnapshot {
    return this.current;
  }

  async commit(
    operation: (
      expected: SessionActivationExpectation,
    ) => Promise<SessionLifecycleMutationResult>,
  ): Promise<AcceptedMutation> {
    await this.events.drain();
    const result = await operation(this.expectation());
    if (!result.accepted)
      throw new Error(`request_lifecycle_rejected:${result.reason}`);
    this.current = result.current;
    this.sealed = result.current.status !== "streaming";
    this.publishCommitted(result.events);
    return result;
  }

  /** A failed event write cannot turn a committed wait into an execution failure. */
  async finalizeFailure(
    input: Readonly<{
      commandId: string;
      cause: SessionRequestTerminalCause;
      message: SessionTerminalMessage;
      error: string;
    }>,
  ): Promise<SessionRequestLifecycleSnapshot> {
    this.sealed = true;
    await this.tail;
    const current = await this.store.get(
      this.current.sessionId,
      this.current.requestId,
    );
    if (!current) throw new Error("request_lifecycle_missing_after_failure");
    if (!sameOwnedActivation(current, this.current)) return current;
    this.current = current;
    if (current.status === "awaiting_approval") {
      if (input.cause !== "request_cancelled") return current;
      if (!current.wait) throw new Error("request_lifecycle_wait_missing");
      const cancelled = await this.store.cancelWait(current.sessionId, {
        expected: {
          requestId: current.requestId,
          generation: current.generation,
          revision: current.revision,
          waitId: current.wait.waitId,
        },
        commandId: input.commandId,
        message: input.message,
      });
      return this.acceptTerminalMutation(cancelled);
    }
    if (current.status !== "streaming") return current;
    return this.acceptTerminalMutation(
      await this.store.commitTerminal(current.sessionId, {
        expected: this.expectation(),
        commandId: input.commandId,
        status: "failed",
        cause: input.cause,
        message: input.message,
        error: input.error,
      }),
    );
  }

  private acceptTerminalMutation(
    result: SessionLifecycleMutationResult,
  ): SessionRequestLifecycleSnapshot {
    if (!result.accepted)
      throw new Error(`request_lifecycle_rejected:${result.reason}`);
    this.current = result.current;
    this.publishCommitted(result.events);
    return result.current;
  }

  private expectation(): SessionActivationExpectation {
    const activation = this.current.activation;
    if (!activation) throw new Error("request_activation_missing");
    return {
      requestId: this.current.requestId,
      generation: this.current.generation,
      revision: this.current.revision,
      ...activation,
    };
  }

  private enqueue(payload: Record<string, unknown>): void {
    if (this.sealed) return;
    this.tail = this.tail
      .then(async () => {
        if (this.persistenceError) return;
        const result = await this.store.appendActivationEvent(
          this.current.sessionId,
          {
            expected: this.expectation(),
            payload,
          },
        );
        if (!result.accepted)
          throw new Error(`request_event_rejected:${result.reason}`);
        this.current = result.current;
        this.publishCommitted(result.events);
      })
      .catch((error: unknown) => {
        this.persistenceError ??= error;
      });
  }

  private publishCommitted(events: readonly Record<string, unknown>[]): void {
    for (const event of events) {
      try {
        this.ws.send(JSON.stringify(event));
      } catch (error: unknown) {
        // Delivery can be restored from the session; it cannot undo a commit.
        traceDebug("runtime.request", "committed_event_delivery_failed", {
          requestId: this.current.requestId,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
    }
  }
}

function sameOwnedActivation(
  current: SessionRequestLifecycleSnapshot,
  owned: SessionRequestLifecycleSnapshot,
): boolean {
  if (current.generation !== owned.generation) return false;
  if (current.activation?.activationId !== owned.activation?.activationId)
    return false;
  return current.activation?.ownerEpoch === owned.activation?.ownerEpoch;
}
