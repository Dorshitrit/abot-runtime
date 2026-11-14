import type WebSocket from "ws";
import { RequestLifecycle } from "../orchestration/lifecycle/request-lifecycle.js";
import { traceDebug } from "../observability/debug-logger.js";
import { resolveRequestDependencies } from "../request/dependencies.js";
import type {
  RequestHandlerOptions,
  RunRequestMessage,
} from "../request/contracts.js";
import { parseRuntimeCommand, RuntimeCommandInputError } from "./catalog.js";
import { compactSessionCommand } from "./compact.js";
import { createCommandModelContext } from "./model-context.js";
import type { RuntimeCommandInvocation } from "./contracts.js";

const runHandlers = Object.freeze({ compact: compactSessionCommand });

export function validateCommandRequest(
  message: RunRequestMessage,
): RuntimeCommandInvocation {
  const command = parseRuntimeCommand(message.command);
  if (message.input?.trim() || message.text?.trim())
    throw new RuntimeCommandInputError("command_text_not_supported");
  if (
    message.attachments !== undefined &&
    (!Array.isArray(message.attachments) || message.attachments.length > 0)
  )
    throw new RuntimeCommandInputError("command_attachments_not_supported");
  if (typeof message.sessionId !== "string" || !message.sessionId.trim())
    throw new RuntimeCommandInputError("sessionId_required");
  return command;
}

/** Invoked inside the shared session admission. Command execution never enters chat finalization. */
export async function handleCommandRun(
  ws: WebSocket,
  message: RunRequestMessage,
  command: RuntimeCommandInvocation,
  options: RequestHandlerOptions,
): Promise<void> {
  if (command.mode !== "run")
    throw new RuntimeCommandInputError("command_mode_not_supported");
  const sessionId = String(message.sessionId).trim();
  const dependencies = resolveRequestDependencies(options);
  const store = dependencies.sessionStore;
  const session = await store.getOrCreateSession(sessionId);
  if (
    session.requests?.some((request) => request.requestId === message.requestId)
  )
    throw new RuntimeCommandInputError("command_request_already_exists");
  const lifecycle = new RequestLifecycle({
    requestId: message.requestId,
    abortSignal: options.abortSignal,
  });
  const events = dependencies.eventSinkFactory.create({
    requestId: message.requestId,
    ws,
  });
  let finalizationClaimed = false;
  const claimFinalization = () => {
    if (finalizationClaimed) return;
    lifecycle.signal.throwIfAborted();
    options.claimFinalization?.();
    lifecycle.dispose();
    finalizationClaimed = true;
  };
  const publishCommandEvent = async (payload: Record<string, unknown>) => {
    const event = {
      ...payload,
      requestId: message.requestId,
      sessionId,
      requestKind: "command",
      command,
    };
    const saved = await store.appendRequestEvent(
      sessionId,
      message.requestId,
      event,
    );
    const recorded = saved.requests
      ?.find((request) => request.requestId === message.requestId)
      ?.events.at(-1)?.payload;
    // Durable events remain replayable even if their live connection has closed.
    try {
      await events.publish(recorded ?? event);
    } catch (error) {
      traceDebug("runtime.commands", "event_delivery_failed", {
        requestId: message.requestId,
        error: String(error),
      });
    }
  };
  try {
    // A single store mutation creates the stream with its identity. Reloads can
    // never observe an unclassified command and manufacture an assistant row.
    await publishCommandEvent({
      type: "event",
      name: "command.started",
    });
    let completion: Record<string, unknown>;
    try {
      await options.onAccepted?.();
      lifecycle.signal.throwIfAborted();
      const binding = createCommandModelContext(
        message,
        options,
        lifecycle.signal,
        dependencies,
      );
      const handler = runHandlers[command.name as keyof typeof runHandlers];
      if (!handler) throw new RuntimeCommandInputError("unknown_command");
      const result = await handler(binding, session, claimFinalization);
      claimFinalization();
      completion = {
        type: "completed",
        name: result.eventName,
        ...result.details,
        outcome: result.outcome,
      };
    } catch (error) {
      completion = {
        type: "failed",
        name: "command.failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await publishCommandEvent(completion);
  } finally {
    lifecycle.dispose();
    await events.drain();
    events.dispose();
  }
}
