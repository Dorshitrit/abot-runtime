import {
  permitsRequiredToolMode,
  requiresToolActionApproval,
} from "../../../../capabilities/tool-permission-mode.js";
import type {
  ToolCall,
  RegisteredToolNormalInvocation,
} from "../../../../capabilities/tool-types.js";
import type {
  ToolApprovalRequest,
  ToolPermissionMode,
} from "../../../ports.js";
import type {
  BoundOperation,
  RegisteredToolNormalInvocationExecutorParams,
  RegisteredToolNormalInvocationPreparation,
} from "../shared/contracts.js";
import { createRegisteredToolActionFingerprint } from "../shared/action-fingerprint.js";
import {
  captureToolCall,
  resolveExactTargetOperation,
  validateCompleteCall,
} from "./call-binding.js";
import { captureExecutionBinding } from "./execution-binding.js";
import { createPreparedNormalInvocation } from "./prepared-execution.js";

type OperationIdentity = Readonly<{
  tool: string;
  operationId: string;
  contractVersion: number;
}>;
export type RegisteredToolInvocationSnapshot = Readonly<{
  kind: "registered_tool_normal_invocation_v1";
  source: OperationIdentity;
  target: OperationIdentity;
  call: ToolCall;
  acceptedControls: Readonly<Record<string, unknown>>;
  actionFingerprint: string;
  toolPermissionMode: ToolPermissionMode;
  intent?: string;
  eventMeta?: Record<string, unknown>;
  executionIdentity?: string;
  approvalRequest?: ToolApprovalRequest;
}>;

/** Validate a saved exact call; restoration never invokes normalization or payload authoring. */
export function restoreNormalInvocation(params: {
  executor: RegisteredToolNormalInvocationExecutorParams;
  registrations: readonly RegisteredToolNormalInvocation[];
  snapshot: unknown;
}): RegisteredToolNormalInvocationPreparation {
  const value = params.snapshot as RegisteredToolInvocationSnapshot | null;
  if (!isInvocationSnapshot(value)) throw invalid();
  if (value.toolPermissionMode !== params.executor.toolPermissionMode)
    throw invalid();
  const source = findOperation(params.registrations, value.source);
  const target = findOperation(params.registrations, value.target);
  const call = captureToolCall(value.call);
  if (!source || !target || !call || call.tool !== target.registration.toolName)
    throw invalid();
  const resolved = resolveExactTargetOperation(params.registrations, call);
  if (
    !resolved.ok ||
    resolved.binding.operation.operationId !== target.operation.operationId
  )
    throw invalid();
  if (source.operation.effect !== target.operation.effect) throw invalid();
  for (const binding of [source, target]) {
    if (
      !permitsRequiredToolMode(
        params.executor.toolPermissionMode,
        binding.registration.definition.requiredPermissionMode,
      )
    )
      throw invalid();
  }
  const validation = validateCompleteCall({
    adapter: target.registration.adapter,
    call,
    rejectedCode: "checkpoint_call_invalid",
    failedCode: "checkpoint_validation_failed",
    failedMessage: "The saved invocation could not be validated.",
  });
  if (!validation.ok) throw invalid();
  const binding = captureExecutionBinding(target.registration.adapter, call);
  if (!binding.ok) throw invalid();
  const fingerprint = createRegisteredToolActionFingerprint({
    contractVersion: target.registration.contract.version,
    operationId: target.operation.operationId,
    call,
    ...(binding.identity ? { executionIdentity: binding.identity } : {}),
  });
  if (
    fingerprint !== value.actionFingerprint ||
    binding.identity !== value.executionIdentity
  )
    throw invalid();
  const force =
    source.operation.approval === "always" ||
    target.operation.approval === "always";
  const required = requiresToolActionApproval(
    params.executor.toolPermissionMode,
    force,
  );
  if (required !== Boolean(value.approvalRequest)) throw invalid();
  if (value.approvalRequest) {
    if (!isRequestApproval(value.approvalRequest, params.executor.requestId))
      throw invalid();
    const approvalFingerprint = createRegisteredToolActionFingerprint({
      contractVersion: target.registration.contract.version,
      operationId: target.operation.operationId,
      call: value.approvalRequest.call,
      ...(binding.identity ? { executionIdentity: binding.identity } : {}),
    });
    if (approvalFingerprint !== fingerprint) throw invalid();
  }
  return createPreparedNormalInvocation({
    executor: params.executor,
    source,
    target,
    call,
    actionFingerprint: fingerprint,
    acceptedControls: Object.freeze(structuredClone(value.acceptedControls)),
    eventMeta: value.eventMeta,
    ...(value.intent ? { intent: value.intent } : {}),
    ...(binding.identity ? { executionIdentity: binding.identity } : {}),
    ...(binding.metadata ? { executionMetadata: binding.metadata } : {}),
    ...(value.approvalRequest
      ? { restoredApprovalRequest: value.approvalRequest }
      : {}),
  });
}

function isInvocationSnapshot(
  value: RegisteredToolInvocationSnapshot | null,
): value is RegisteredToolInvocationSnapshot {
  if (!value || value.kind !== "registered_tool_normal_invocation_v1")
    return false;
  return (
    isRecord(value.acceptedControls) &&
    isRecord(value.call) &&
    typeof value.call.tool === "string" &&
    isRecord(value.call.params) &&
    typeof value.actionFingerprint === "string" &&
    value.actionFingerprint.length > 0 &&
    (value.intent === undefined || typeof value.intent === "string") &&
    (value.eventMeta === undefined || isRecord(value.eventMeta)) &&
    (value.executionIdentity === undefined ||
      typeof value.executionIdentity === "string") &&
    (value.approvalRequest === undefined || isRecord(value.approvalRequest))
  );
}

function isRequestApproval(
  approval: ToolApprovalRequest,
  requestId: string,
): boolean {
  if (
    !isRecord(approval) ||
    approval.requestId !== requestId ||
    !isRecord(approval.call)
  )
    return false;
  return (
    typeof approval.approvalId === "string" &&
    approval.approvalId.trim().length > 0
  );
}

function findOperation(
  registrations: readonly RegisteredToolNormalInvocation[],
  identity: OperationIdentity | undefined,
): BoundOperation | undefined {
  if (!identity) return undefined;
  const registration = registrations.find(
    (entry) =>
      entry.toolName === identity.tool &&
      entry.contract.version === identity.contractVersion,
  );
  const operation = registration?.contract.operations.find(
    (entry) => entry.operationId === identity.operationId,
  );
  return registration && operation ? { registration, operation } : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(): Error {
  return new Error("registered_tool_snapshot_incompatible");
}
