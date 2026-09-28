import type {
  SessionCancelWaitCommand,
  SessionCommitTerminalCommand,
  SessionInterruptActivationCommand,
  SessionLifecycleMutationResult,
  SessionTerminalMessage,
} from "./contracts.js";
import {
  acceptedLifecycle,
  appendLifecycleChangedEvent,
  appendLifecycleEvent,
  appendLifecycleMessage,
  hasNonemptyIdentity,
  lifecycleRequest,
  rejectLifecycleCommand,
  touchLifecycle,
  validateActivationExpectation,
  validateWaitExpectation,
  type LifecycleMutationContext,
  type LifecycleRequest,
} from "./record-operations.js";

function appendTerminalResponse(
  context: LifecycleMutationContext,
  request: LifecycleRequest,
  message: SessionTerminalMessage,
): void {
  const { lastAgentMode, ...metadata } = message;
  appendLifecycleMessage(context, {
    ...metadata,
    role: "assistant",
    kind: "terminal",
    requestId: request.requestId,
    source: "request",
    grounding: message.grounding ?? "conversation",
  });
  if (lastAgentMode) context.session.lastAgentMode = lastAgentMode;
}

function hasTerminalCommandReceipt(
  request: LifecycleRequest,
  commandId: string,
): boolean {
  if (request.status !== "completed" && request.status !== "failed")
    return false;
  return request.lifecycle.terminalCommandId === commandId;
}

export function commitSessionTerminal(
  context: LifecycleMutationContext,
  command: SessionCommitTerminalCommand,
): SessionLifecycleMutationResult {
  const request = lifecycleRequest(context.session, command.expected.requestId);
  if (!request) return rejectLifecycleCommand("lifecycle_missing");
  if (request.generation !== command.expected.generation)
    return rejectLifecycleCommand("generation_mismatch", request);
  if (hasTerminalCommandReceipt(request, command.commandId))
    return { ...acceptedLifecycle(request), duplicate: true };
  const mismatch = validateActivationExpectation(request, command.expected);
  if (mismatch) return rejectLifecycleCommand(mismatch, request);
  if (!hasNonemptyIdentity(command.commandId))
    return rejectLifecycleCommand("invalid_command", request);
  if (!hasNonemptyIdentity(command.message.content))
    return rejectLifecycleCommand("invalid_command", request);
  if (command.status !== "completed" && command.status !== "failed")
    return rejectLifecycleCommand("invalid_command", request);
  request.status = command.status;
  request.lifecycle.terminalCommandId = command.commandId;
  request.lifecycle.terminalCause =
    command.status === "failed"
      ? (command.cause ?? "request_failed")
      : undefined;
  delete request.lifecycle.wait;
  touchLifecycle(context, request);
  appendTerminalResponse(context, request, command.message);
  const payload =
    command.status === "completed"
      ? { type: "completed", output: command.message.content }
      : {
          type: "failed",
          error: command.error ?? request.lifecycle.terminalCause,
          details: {
            stoppedResponse:
              command.cause === "request_cancelled"
                ? command.message.content
                : undefined,
          },
        };
  const changed = appendLifecycleChangedEvent(context, request);
  const event = appendLifecycleEvent(context, request, payload);
  return acceptedLifecycle(request, [changed, event]);
}

export function cancelSessionApprovalWait(
  context: LifecycleMutationContext,
  command: SessionCancelWaitCommand,
): SessionLifecycleMutationResult {
  const request = lifecycleRequest(context.session, command.expected.requestId);
  if (!request) return rejectLifecycleCommand("lifecycle_missing");
  if (request.generation !== command.expected.generation)
    return rejectLifecycleCommand("generation_mismatch", request);
  if (hasTerminalCommandReceipt(request, command.commandId))
    return { ...acceptedLifecycle(request), duplicate: true };
  const mismatch = validateWaitExpectation(request, command.expected);
  if (mismatch) return rejectLifecycleCommand(mismatch, request);
  if (!hasNonemptyIdentity(command.commandId))
    return rejectLifecycleCommand("invalid_command", request);
  if (!hasNonemptyIdentity(command.message.content))
    return rejectLifecycleCommand("invalid_command", request);
  const presentation = context.session.messages.find(
    (message) => message.id === request.lifecycle.wait!.presentationMessageId,
  );
  if (presentation?.approvalRequest)
    presentation.approvalRequest = {
      ...presentation.approvalRequest,
      state: "cancelled",
    };
  request.status = "failed";
  request.lifecycle.terminalCause = "request_cancelled";
  request.lifecycle.terminalCommandId = command.commandId;
  delete request.lifecycle.wait;
  touchLifecycle(context, request);
  appendTerminalResponse(context, request, command.message);
  const changed = appendLifecycleChangedEvent(context, request);
  const event = appendLifecycleEvent(context, request, {
    type: "failed",
    error: "request_cancelled",
    details: { stoppedResponse: command.message.content },
  });
  return acceptedLifecycle(request, [changed, event]);
}

export function interruptSessionActivation(
  context: LifecycleMutationContext,
  command: SessionInterruptActivationCommand,
): SessionLifecycleMutationResult {
  return commitSessionTerminal(context, {
    ...command,
    status: "failed",
    cause: "request_interrupted",
    error: "request_interrupted",
  });
}
