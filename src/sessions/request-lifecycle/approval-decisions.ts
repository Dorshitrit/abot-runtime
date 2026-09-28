import type {
  SessionCommitDecisionCommand,
  SessionLifecycleMutationResult,
} from "./contracts.js";
import {
  acceptedLifecycle,
  appendLifecycleChangedEvent,
  appendLifecycleEvent,
  hasNonemptyIdentity,
  lifecycleRequest,
  rejectLifecycleCommand,
  touchLifecycle,
  validateWaitExpectation,
  type LifecycleMutationContext,
  type LifecycleRequest,
} from "./record-operations.js";

function sameDecision(
  receipt: LifecycleRequest["lifecycle"]["decisionReceipts"][number],
  command: SessionCommitDecisionCommand,
): boolean {
  if (receipt.waitId !== command.expected.waitId) return false;
  if (receipt.approvalId !== command.approvalId) return false;
  if (receipt.approved !== command.approved) return false;
  return receipt.reason === command.reason;
}

function replayDecision(
  request: LifecycleRequest,
  command: SessionCommitDecisionCommand,
): SessionLifecycleMutationResult | undefined {
  const commandReceipt = request.lifecycle.decisionReceipts.find(
    (receipt) => receipt.commandId === command.commandId,
  );
  if (commandReceipt && !sameDecision(commandReceipt, command))
    return rejectLifecycleCommand("decision_command_conflict", request);
  const receipt =
    commandReceipt ??
    request.lifecycle.decisionReceipts.find(
      (value) =>
        value.approvalId === command.approvalId &&
        value.waitId === command.expected.waitId,
    );
  if (!receipt) return undefined;
  if (!sameDecision(receipt, command))
    return rejectLifecycleCommand("approval_already_decided", request);
  return {
    ...acceptedLifecycle(request),
    duplicate: true,
    receipt: structuredClone(receipt),
  };
}

function isLastApprovalDecision(
  request: LifecycleRequest,
  approvalId: string,
): boolean {
  const wait = request.lifecycle.wait!;
  return wait.approvals.every(
    (approval) =>
      approval.approvalId === approvalId ||
      request.lifecycle.decisionReceipts.some(
        (receipt) =>
          receipt.waitId === wait.waitId &&
          receipt.approvalId === approval.approvalId,
      ),
  );
}

function hasResumeActivation(command: SessionCommitDecisionCommand): boolean {
  if (!hasNonemptyIdentity(command.resumeActivation?.activationId))
    return false;
  return hasNonemptyIdentity(command.resumeActivation?.ownerEpoch);
}

export function commitSessionApprovalDecision(
  context: LifecycleMutationContext,
  command: SessionCommitDecisionCommand,
): SessionLifecycleMutationResult {
  const request = lifecycleRequest(context.session, command.expected.requestId);
  if (!request) return rejectLifecycleCommand("lifecycle_missing");
  if (request.generation !== command.expected.generation)
    return rejectLifecycleCommand("generation_mismatch", request);
  if (!hasNonemptyIdentity(command.commandId))
    return rejectLifecycleCommand("invalid_command", request);
  if (typeof command.approved !== "boolean")
    return rejectLifecycleCommand("invalid_command", request);
  const replay = replayDecision(request, command);
  if (replay) return replay;
  const mismatch = validateWaitExpectation(request, command.expected);
  if (mismatch) return rejectLifecycleCommand(mismatch, request);
  const wait = request.lifecycle.wait!;
  const approval = wait.approvals.find(
    (entry) => entry.approvalId === command.approvalId,
  );
  if (!approval) return rejectLifecycleCommand("approval_missing", request);
  const final = isLastApprovalDecision(request, command.approvalId);
  if (final && !hasResumeActivation(command))
    return rejectLifecycleCommand("resume_activation_required", request);
  if (
    final &&
    command.resumeActivation!.activationId ===
      request.lifecycle.activation.activationId
  )
    return rejectLifecycleCommand("activation_mismatch", request);
  touchLifecycle(context, request);
  const receipt = {
    commandId: command.commandId,
    requestId: request.requestId,
    generation: request.generation,
    waitId: wait.waitId,
    approvalId: command.approvalId,
    approved: command.approved,
    ...(command.reason !== undefined ? { reason: command.reason } : {}),
    committedAt: context.timestamp,
    revision: request.lifecycle.revision,
    ...(final
      ? { activation: structuredClone(command.resumeActivation!) }
      : {}),
  };
  request.lifecycle.decisionReceipts.push(receipt);
  const message = context.session.messages.find(
    (entry) => entry.id === wait.presentationMessageId,
  );
  if (message?.approvalRequest)
    message.approvalRequest = {
      ...message.approvalRequest,
      state: final ? "consumed" : "pending",
      decisions: request.lifecycle.decisionReceipts.filter(
        (value) => value.waitId === wait.waitId,
      ),
    };
  if (final) {
    request.status = "streaming";
    request.lifecycle.activation = structuredClone(command.resumeActivation!);
    delete request.lifecycle.wait;
  }
  const event = appendLifecycleEvent(context, request, {
    ...approval.presentation,
    type: "event",
    name: command.approved ? "tool.approval.granted" : "tool.approval.rejected",
    approvalId: approval.approvalId,
    waitId: wait.waitId,
    ...(command.reason !== undefined ? { reason: command.reason } : {}),
  });
  return {
    ...acceptedLifecycle(request, [
      event,
      appendLifecycleChangedEvent(context, request),
    ]),
    receipt: structuredClone(receipt),
  };
}
