import {
  WORKER_CAPABILITY_INTENT_MAX_LENGTH,
  type WorkerDecisionValidationIssue,
} from "../contracts.js";
import { workerCapabilityBatchExecutionSlotId } from "../format.js";
import { parseCapabilityInvocation } from "./capability-invocation-validation.js";
import {
  readWorkerDecisionRecord,
  validateExactWorkerDecisionKeys,
} from "./decision-shape-validation.js";
import type {
  AcceptedCapabilityInvocation,
  ActionValidation,
  CapabilityInvocationValidation,
  DecisionValidationContext,
  PendingCapabilityInvocation,
} from "./validation-contract.js";
import { createWorkerDecisionIssue } from "./validation-contract.js";

export function validateCapabilityBatchDecision(
  record: Record<string, unknown>,
  context: DecisionValidationContext,
  issues: WorkerDecisionValidationIssue[],
): ActionValidation {
  validateExactWorkerDecisionKeys(record, ["action", "invocations"], issues);
  const invocations = readCapabilityBatchInvocations(
    record.invocations,
    context,
  );
  if (!hasAllowedCapabilityBatchSize(invocations, context)) {
    issues.push(
      createWorkerDecisionIssue(
        "worker_capability_batch_size_invalid",
        "decision.invocations",
      ),
    );
    return {};
  }

  const acceptedBatchInvocations: AcceptedCapabilityInvocation[] = [];
  invocations.forEach((input, index) => {
    const pendingSlotId = capabilityBatchPendingSlotId(context, index);
    const path = pendingSlotId
      ? `decision.invocations.${pendingSlotId}`
      : `decision.invocations[${index}]`;
    const invocationRecord = readWorkerDecisionRecord(input);
    if (!invocationRecord) {
      issues.push(
        createWorkerDecisionIssue("worker_capability_batch_item_invalid", path),
      );
      return;
    }
    const pendingInvocation = pendingCapabilityBatchInvocation(context, index);
    const invocation = parseCapabilityInvocation(
      {
        record: invocationRecord,
        path,
        includesActionKey: false,
        observationOnly: true,
        executionRequiresPendingInvocation: false,
        decisionPhase: context.decisionPhase,
        availableCapabilities: context.availableCapabilities,
        pendingInvocation,
        pendingSlotId,
      },
      issues,
    );
    if (
      !canAcceptObservationBatchInvocation(
        context,
        invocationRecord,
        invocation,
        pendingInvocation,
      )
    ) {
      return;
    }
    acceptedBatchInvocations.push(
      projectAcceptedCapabilityInvocation(
        context,
        invocationRecord,
        invocation,
        pendingInvocation,
      ),
    );
  });
  return { acceptedBatchInvocations };
}

function readCapabilityBatchInvocations(
  value: unknown,
  context: DecisionValidationContext,
): unknown[] | undefined {
  if (context.decisionPhase === "capability_execution") {
    return readPendingCapabilityBatchExecutionSlots(
      value,
      context.pendingCapabilityBatchSelection?.length,
    );
  }
  return Array.isArray(value) ? value : undefined;
}

function capabilityBatchPendingSlotId(
  context: DecisionValidationContext,
  index: number,
): string | undefined {
  if (context.decisionPhase !== "capability_execution") return undefined;
  return workerCapabilityBatchExecutionSlotId(index);
}

function pendingCapabilityBatchInvocation(
  context: DecisionValidationContext,
  index: number,
): PendingCapabilityInvocation | undefined {
  if (context.decisionPhase !== "capability_execution") return undefined;
  return context.pendingCapabilityBatchSelection?.[index];
}

function hasAllowedCapabilityBatchSize(
  invocations: unknown[] | undefined,
  context: DecisionValidationContext,
): invocations is unknown[] {
  if (!invocations) return false;
  if (context.decisionPhase === "capability_execution") {
    if (!context.pendingCapabilityBatchSelection) return false;
    return (
      invocations.length === context.pendingCapabilityBatchSelection.length
    );
  }
  if (invocations.length < 2) return false;
  if (!Number.isInteger(context.maxBatchCapabilityExecutions)) return false;
  if (context.maxBatchCapabilityExecutions < 2) return false;
  return invocations.length <= context.maxBatchCapabilityExecutions;
}

function canAcceptObservationBatchInvocation(
  context: DecisionValidationContext,
  invocationRecord: Record<string, unknown>,
  invocation: CapabilityInvocationValidation,
  pendingInvocation: PendingCapabilityInvocation | undefined,
): boolean {
  if (invocation.selectedCapability?.effect !== "observation") return false;
  if (
    !pendingInvocation &&
    !hasValidGeneratedCapabilityIdentity(invocationRecord)
  ) {
    return false;
  }
  if (context.decisionPhase === "capability_execution") {
    return invocation.controls !== undefined;
  }
  if (!invocation.controlsPartition?.selectionControlIds.length) return true;
  return invocation.selectionControls !== undefined;
}

function hasValidGeneratedCapabilityIdentity(
  invocation: Record<string, unknown>,
): boolean {
  if (typeof invocation.capabilityId !== "string") return false;
  if (typeof invocation.intent !== "string") return false;
  if (invocation.intent.trim().length === 0) return false;
  return invocation.intent.length <= WORKER_CAPABILITY_INTENT_MAX_LENGTH;
}

function projectAcceptedCapabilityInvocation(
  context: DecisionValidationContext,
  invocationRecord: Record<string, unknown>,
  invocation: CapabilityInvocationValidation,
  pendingInvocation: PendingCapabilityInvocation | undefined,
): AcceptedCapabilityInvocation {
  const capabilityId =
    pendingInvocation?.capabilityId ??
    (invocationRecord.capabilityId as string);
  const intent =
    pendingInvocation?.intent ?? (invocationRecord.intent as string).trim();
  const authoringObjective =
    pendingInvocation?.authoringObjective ?? invocation.authoringObjective;
  if (context.decisionPhase === "capability_execution") {
    return Object.freeze({
      capabilityId,
      intent,
      ...(authoringObjective ? { authoringObjective } : {}),
      controls: invocation.controls!,
    });
  }
  return Object.freeze({
    capabilityId,
    intent,
    ...(authoringObjective ? { authoringObjective } : {}),
    ...(invocation.selectionControls
      ? { selectionControls: invocation.selectionControls }
      : {}),
  });
}

function readPendingCapabilityBatchExecutionSlots(
  value: unknown,
  expectedCount: number | undefined,
): unknown[] | undefined {
  const record = readWorkerDecisionRecord(value);
  if (!record || expectedCount === undefined) return undefined;
  const expectedSlotIds = Array.from({ length: expectedCount }, (_, index) =>
    workerCapabilityBatchExecutionSlotId(index),
  );
  const actualSlotIds = Object.keys(record);
  if (!hasExactPendingBatchExecutionSlots(actualSlotIds, expectedSlotIds)) {
    return undefined;
  }
  return expectedSlotIds.map((slotId) => record[slotId]);
}

function hasExactPendingBatchExecutionSlots(
  actualSlotIds: readonly string[],
  expectedSlotIds: readonly string[],
): boolean {
  if (actualSlotIds.length !== expectedSlotIds.length) return false;
  return actualSlotIds.every((slotId) => expectedSlotIds.includes(slotId));
}
