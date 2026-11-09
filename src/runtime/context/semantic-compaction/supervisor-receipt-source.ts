import type {
  RoleCallFrame,
  RoleCallLedgerHead,
  RoleCapabilityExecution,
} from "../../orchestration/role-calls/contracts.js";
import {
  projectStoredCompletedRoleChild,
  type CompletedRoleChildResult,
} from "../../orchestration/role-calls/child-return.js";
import { projectCanonicalRequestToolResult } from "../canonical-capability-result.js";
import { CompactionSourceInvariantError } from "../compaction-source-invariant.js";
import type { RequestToolResult } from "../request-tool-results.js";
import { hasSuperContextContract } from "../super-context-policy.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionSource,
} from "./contracts.js";

const SOURCE_PREFIX = "supervisor-receipt:";
const SOURCE_KIND = "runtime_supervisor_tool_receipt_source_v1";

export type SupervisorReceiptSourceInput = Readonly<{
  head: RoleCallLedgerHead;
  consumerCallId: string;
  executionId: string;
}>;

type ReceiptLineage = Readonly<{
  execution: RoleCapabilityExecution;
  producer: RoleCallFrame;
  child: CompletedRoleChildResult;
}>;

/** Receipt bytes have their own identity; full Worker evidence keeps its original key. */
export function supervisorReceiptSourceRef(
  consumerCallId: string,
  executionId: string,
): string {
  return SOURCE_PREFIX + hash(JSON.stringify([consumerCallId, executionId])).slice("sha256:".length);
}

export function isSupervisorReceiptCompactionSource(
  source: SemanticCompactionSource,
): boolean {
  return source.sourceRef.startsWith(SOURCE_PREFIX);
}

export function isSupervisorReceiptExecutionEligible(
  input: SupervisorReceiptSourceInput,
): boolean {
  return resolveReceiptLineage(input) !== undefined;
}

/** Never adds the producer's hidden adapter body or reference data to its parent. */
export function projectSupervisorReceipt(
  input: SupervisorReceiptSourceInput,
): RequestToolResult {
  const lineage = requireReceiptLineage(input);
  return projectReceipt(input.head, lineage.execution);
}

export function createSupervisorReceiptCompactionSource(
  input: SupervisorReceiptSourceInput,
): SemanticCompactionSource {
  const { execution, producer, child } = requireReceiptLineage(input);
  const content = JSON.stringify({
    kind: SOURCE_KIND,
    authority: "reference_data",
    consumerCallId: input.consumerCallId,
    completedChildCallId: child.childCallId,
    completedChildResultRef: child.resultRef,
    producerObjectiveFingerprint: hash(producer.objective!),
    lineageFingerprint: child.workLineage!.lineageFingerprint,
    receipt: projectReceipt(input.head, execution),
  });
  return Object.freeze({
    sourceRef: supervisorReceiptSourceRef(input.consumerCallId, input.executionId),
    sourceFingerprint: hash(content),
    content,
  });
}

/** Restore checks the original receipt and its completed subtree, not newer display state. */
export function assertSupervisorReceiptCompactionSource(params: Readonly<{
  source: SemanticCompactionSource;
  head: RoleCallLedgerHead;
  scopeCall?: RoleCallFrame;
}>): void {
  const { source, head, scopeCall } = params;
  const binding = readReceiptSourceBinding(source);
  if (!hasReceiptConsumerScope(binding.consumerCallId, scopeCall))
    throw new CompactionSourceInvariantError("context_compaction_supervisor_receipt_owner_invalid", source.sourceRef);
  const canonical = createSupervisorReceiptCompactionSource({ head, ...binding });
  if (!hasExactReceiptSource(source, canonical))
    throw new CompactionSourceInvariantError("context_compaction_supervisor_receipt_source_changed", source.sourceRef);
}

function requireReceiptLineage(input: SupervisorReceiptSourceInput): ReceiptLineage {
  const lineage = resolveReceiptLineage(input);
  if (!lineage)
    throw new CompactionSourceInvariantError(
      "context_compaction_supervisor_receipt_lineage_invalid",
      supervisorReceiptSourceRef(input.consumerCallId, input.executionId),
    );
  return lineage;
}

function resolveReceiptLineage(input: SupervisorReceiptSourceInput): ReceiptLineage | undefined {
  const { head, consumerCallId, executionId } = input;
  const consumer = head.state.calls.find((call) => call.callId === consumerCallId);
  if (!isCanonicalSupervisorReceiptConsumer(head, consumer)) return undefined;
  const execution = head.state.capabilityExecutions.find((entry) => entry.executionId === executionId);
  if (!isSettledDescendantExecution(execution, consumer)) return undefined;
  const producer = head.state.calls.find((call) => call.callId === execution.callId);
  if (!isCompletedWorkerProducer(producer)) return undefined;
  for (const childCallId of consumer.childCallIds) {
    const childCall = head.state.calls.find((call) => call.callId === childCallId);
    if (!isCompletedWorkChild(childCall, consumer)) continue;
    const child = projectStoredCompletedRoleChild(
      head.state, { callerCallId: consumer.callId, childCallId }, head.policy,
    );
    if (!child.workLineage?.capabilityExecutionIds.includes(executionId)) continue;
    return { execution, producer, child };
  }
  return undefined;
}

function isCanonicalSupervisorReceiptConsumer(
  head: RoleCallLedgerHead,
  call: RoleCallFrame | undefined,
): call is RoleCallFrame {
  if (!hasSuperContextContract(head.policy.authority, "supervisor")) return false;
  if (!call || call.callId !== head.state.rootCallId) return false;
  if (call.roleId !== "supervisor") return false;
  if (call.parentCallId !== null) return false;
  return call.depth === 0;
}

function isSettledDescendantExecution(
  execution: RoleCapabilityExecution | undefined,
  consumer: RoleCallFrame,
): execution is RoleCapabilityExecution {
  if (!execution || execution.status !== "settled") return false;
  return execution.callId !== consumer.callId;
}

function isCompletedWorkerProducer(call: RoleCallFrame | undefined): call is RoleCallFrame {
  if (!call || call.status !== "completed") return false;
  if (!call.objective?.trim()) return false;
  return call.roleId === "worker";
}

function isCompletedWorkChild(
  child: RoleCallFrame | undefined,
  consumer: RoleCallFrame,
): child is RoleCallFrame {
  if (!child || child.status !== "completed") return false;
  if (child.parentCallId !== consumer.callId) return false;
  return child.roleId === "worker" || child.roleId === "planner";
}

function projectReceipt(head: RoleCallLedgerHead, execution: RoleCapabilityExecution): RequestToolResult {
  const {
    adapterResult: _adapterResult,
    referenceData: _referenceData,
    acceptedAction: _acceptedAction,
    ...receipt
  } = projectCanonicalRequestToolResult(head, execution);
  return Object.freeze(receipt);
}

function readReceiptSourceBinding(source: SemanticCompactionSource): Readonly<{
  consumerCallId: string;
  executionId: string;
}> {
  let parsed: unknown;
  try { parsed = JSON.parse(source.content); } catch {
    throw new CompactionSourceInvariantError("context_compaction_supervisor_receipt_source_invalid", source.sourceRef);
  }
  const record = readRecord(parsed);
  if (!hasReceiptSourceBinding(record))
    throw new CompactionSourceInvariantError("context_compaction_supervisor_receipt_source_invalid", source.sourceRef);
  return { consumerCallId: record.consumerCallId, executionId: record.receipt.executionId };
}

function hasReceiptSourceBinding(
  record: Record<string, unknown> | undefined,
): record is Record<string, unknown> & {
  consumerCallId: string;
  receipt: Record<string, unknown> & { executionId: string };
} {
  if (record?.kind !== SOURCE_KIND) return false;
  if (typeof record.consumerCallId !== "string" || !record.consumerCallId) return false;
  const receipt = readRecord(record.receipt);
  return typeof receipt?.executionId === "string" && receipt.executionId.length > 0;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function hasReceiptConsumerScope(consumerCallId: string, call?: RoleCallFrame): boolean {
  if (!call) return true;
  return call.callId === consumerCallId;
}

function hasExactReceiptSource(source: SemanticCompactionSource, canonical: SemanticCompactionSource): boolean {
  if (source.sourceRef !== canonical.sourceRef) return false;
  if (source.sourceFingerprint !== canonical.sourceFingerprint) return false;
  return source.content === canonical.content;
}
