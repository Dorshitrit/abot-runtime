import { randomUUID } from "node:crypto";
import {
  createInitialApprovalReceipts,
  hasValidInitialApprovalDecisions,
} from "./wait-initial-decisions.js";
import type {
  SessionCommitWaitCommand,
  SessionLifecycleMutationResult,
  SessionStartActivationCommand,
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
  type LifecycleMutationContext,
  type LifecycleRequest,
} from "./record-operations.js";

export function startSessionActivation(
  context: LifecycleMutationContext,
  command: SessionStartActivationCommand,
): SessionLifecycleMutationResult {
  if (!hasNonemptyIdentity(command.requestId))
    return rejectLifecycleCommand("invalid_command");
  if (!hasNonemptyIdentity(command.activationId))
    return rejectLifecycleCommand("invalid_command");
  if (!hasNonemptyIdentity(command.ownerEpoch))
    return rejectLifecycleCommand("invalid_command");
  const existing = context.session.requests?.find(
    (request) => request.requestId === command.requestId,
  );
  if (existing?.lifecycle) {
    const activation = existing.lifecycle.activation;
    if (
      existing.status === "streaming" &&
      activation.activationId === command.activationId &&
      activation.ownerEpoch === command.ownerEpoch
    )
      return {
        ...acceptedLifecycle(existing as LifecycleRequest),
        duplicate: true,
      };
    return rejectLifecycleCommand("request_already_started", existing);
  }
  if (existing && existing.generation !== command.expectedGeneration)
    return rejectLifecycleCommand("generation_mismatch", existing);
  if (existing && !existing.generation)
    return rejectLifecycleCommand("generation_mismatch", existing);
  if (existing && existing.status !== "streaming")
    return rejectLifecycleCommand("request_not_running", existing);
  const request: LifecycleRequest = {
    ...(existing ?? {
      requestId: command.requestId,
      sessionId: context.session.id,
      createdAt: context.timestamp,
      lastSeqNo: 0,
      events: [],
    }),
    generation: existing?.generation ?? randomUUID(),
    status: "streaming",
    updatedAt: context.timestamp,
    lifecycle: {
      schemaVersion: 1,
      revision: 0,
      activation: {
        activationId: command.activationId,
        ownerEpoch: command.ownerEpoch,
      },
      decisionReceipts: [],
    },
  };
  context.session.requests = [
    ...(context.session.requests ?? []).filter(
      (value) => value.requestId !== request.requestId,
    ),
    request,
  ];
  context.session.updatedAt = context.timestamp;
  return acceptedLifecycle(request);
}

function hasDistinctApprovalIdentities(
  command: SessionCommitWaitCommand,
): boolean {
  if (!command.approvals.length) return false;
  const identities = new Set<string>();
  for (const approval of command.approvals) {
    if (!hasNonemptyIdentity(approval.approvalId)) return false;
    if (!hasNonemptyIdentity(approval.actionFingerprint)) return false;
    if (identities.has(approval.approvalId)) return false;
    identities.add(approval.approvalId);
  }
  return true;
}

export function commitSessionApprovalWait(
  context: LifecycleMutationContext,
  command: SessionCommitWaitCommand,
): SessionLifecycleMutationResult {
  const request = lifecycleRequest(context.session, command.expected.requestId);
  const mismatch = validateActivationExpectation(request, command.expected);
  if (mismatch) return rejectLifecycleCommand(mismatch, request);
  if (!hasNonemptyIdentity(command.waitId))
    return rejectLifecycleCommand("invalid_command", request);
  if (!hasNonemptyIdentity(command.presentationText))
    return rejectLifecycleCommand("invalid_command", request);
  if (!hasDistinctApprovalIdentities(command))
    return rejectLifecycleCommand("invalid_command", request);
  if (!hasValidInitialApprovalDecisions(request!, command))
    return rejectLifecycleCommand("invalid_command", request);
  const identitiesReused = command.approvals.some((approval) =>
    request!.lifecycle.decisionReceipts.some(
      (receipt) => receipt.approvalId === approval.approvalId,
    ),
  );
  if (identitiesReused)
    return rejectLifecycleCommand("invalid_command", request);
  const message = appendLifecycleMessage(context, {
    role: "assistant",
    kind: "tool_approval_request",
    content: command.presentationText,
    requestId: request!.requestId,
    source: "request",
    grounding: "conversation",
    approvalRequest: {
      kind: "tool_approval_request",
      waitId: command.waitId,
      state: "pending",
      approvals: command.approvals,
      decisions: [],
    },
  });
  request!.lifecycle.wait = structuredClone({
    waitId: command.waitId,
    createdAt: context.timestamp,
    presentationMessageId: message.id,
    approvals: command.approvals,
    continuation: command.continuation,
  });
  request!.status = "awaiting_approval";
  touchLifecycle(context, request!);
  const initialReceipts = createInitialApprovalReceipts(
    context,
    request!,
    command,
  );
  request!.lifecycle.decisionReceipts.push(...initialReceipts);
  message.approvalRequest = {
    ...message.approvalRequest!,
    decisions: initialReceipts,
  };
  const undisclosedApprovals = command.approvals.filter(
    (approval) =>
      !request!.events.some(
        (event) =>
          event.payload.name === "tool.approval.required" &&
          event.payload.approvalId === approval.approvalId,
      ),
  );
  const events = undisclosedApprovals.map((approval) =>
    appendLifecycleEvent(context, request!, {
      ...approval.presentation,
      type: "event",
      name: "tool.approval.required",
      approvalId: approval.approvalId,
      waitId: command.waitId,
    }),
  );
  for (const receipt of initialReceipts)
    events.push(
      appendLifecycleEvent(context, request!, {
        ...command.approvals.find(
          (approval) => approval.approvalId === receipt.approvalId,
        )?.presentation,
        type: "event",
        name: receipt.approved
          ? "tool.approval.granted"
          : "tool.approval.rejected",
        approvalId: receipt.approvalId,
        waitId: command.waitId,
        ...(receipt.reason ? { reason: receipt.reason } : {}),
      }),
    );
  events.push(appendLifecycleChangedEvent(context, request!));
  return acceptedLifecycle(request!, events);
}
