import { isDeepStrictEqual } from "node:util";
import { FILE_PAYLOAD_TOOL_HANDOFF, FILE_PAYLOAD_TOOL_REQUESTED } from "../../capabilities/file-payload-tool-handoff.js";
import type { CapabilityDescriptor } from "../../orchestration/capability-adapters/index.js";
import type { RoleCallFrame, RoleCapabilityExecution } from "../../orchestration/role-calls/index.js";
import type { ExecutionAgentResolvedCapabilityInvocation } from "../../steps/execution-agent/contracts.js";
import { isFilePayloadObservationCapability } from "./tool-scope.js";

type PendingWrite = ExecutionAgentResolvedCapabilityInvocation;
type Continuation = {
  pending: PendingWrite;
  toolDecision: string;
  toolCapabilityIds: readonly string[];
  phase: "tool" | "write";
  nextInvocationAttempt: number;
  observationToolsOnly: boolean;
};

/** Replay explicit activation bindings from canonical receipts, including nested authoring.
 * No mutable request sidecar is needed to survive an approval checkpoint.
 */
export function projectFilePayloadContinuation(params: {
  executions: readonly RoleCapabilityExecution[];
  call: RoleCallFrame;
  steeringVersion?: number;
  capabilities: readonly CapabilityDescriptor[];
}): Continuation | undefined {
  const stack: Continuation[] = [];
  const groups = new Map<number, RoleCapabilityExecution[]>();
  for (const execution of params.executions) {
    if (execution.callId !== params.call.callId) continue;
    const group = groups.get(execution.invocationAttempt) ?? [];
    group.push(execution);
    groups.set(execution.invocationAttempt, group);
  }
  for (const [attempt, group] of groups) {
    const active = stack.at(-1);
    if (active && !matchesFilePayloadContinuationExecution(active, attempt, group)) stack.length = 0;
    const current = stack.at(-1);
    // Only the accepted root write may mutate; nested writers are auxiliary operations too.
    if (isAuxiliaryContinuationExecution(current, stack.length)) {
      current.observationToolsOnly = current.observationToolsOnly && group.every(hasObservationDeclaration);
    }
    const handoff = group.length === 1 ? readHandoff(group[0]!, params) : undefined;
    if (handoff) {
      handoff.observationToolsOnly = handoff.observationToolsOnly && (current?.observationToolsOnly ?? true);
      if (current?.phase === "write") stack.pop();
      stack.push(handoff);
      continue;
    }
    if (!current) continue;
    if (group.some((execution) => execution.status !== "settled")) return undefined;
    if (current.phase === "tool") {
      current.phase = "write";
      current.nextInvocationAttempt = attempt + 1;
      continue;
    }
    stack.pop();
    const parent = stack.at(-1);
    if (!parent) continue;
    parent.observationToolsOnly = parent.observationToolsOnly && current.observationToolsOnly;
    parent.phase = "write";
    parent.nextInvocationAttempt = attempt + 1;
  }
  const pending = stack.at(-1);
  // A skipped activation (steering, reconsideration or supervision) returns control to EA.
  if (pending?.nextInvocationAttempt !== params.call.activationCount) return undefined;
  return pending;
}

export function matchesFilePayloadContinuationExecution(
  pending: Continuation, attempt: number, group: readonly RoleCapabilityExecution[],
): boolean {
  if (attempt !== pending.nextInvocationAttempt) return false;
  const expected = pending.phase === "tool" ? pending.toolCapabilityIds : [pending.pending.capabilityId];
  // Identical observation requests may be collapsed by the existing batch executor.
  const actualIds = new Set(group.map((execution) => execution.capabilityId));
  if (!isDeepStrictEqual(actualIds, new Set(expected))) return false;
  if (pending.phase === "tool") return true;
  if (group.length !== 1) return false;
  try { return isDeepStrictEqual(JSON.parse(group[0]!.controlsJson), pending.pending.controls); }
  catch { return false; }
}

function hasObservationDeclaration(execution: RoleCapabilityExecution): boolean {
  return isFilePayloadObservationCapability({ effect: execution.declaredEffect });
}

function isAuxiliaryContinuationExecution(
  current: Continuation | undefined, depth: number,
): current is Continuation {
  if (!current) return false;
  if (current.phase === "tool") return true;
  return depth > 1;
}

function hasOnlyObservationToolCapabilities(
  ids: readonly string[], capabilities: readonly CapabilityDescriptor[],
): boolean {
  return ids.every((id) => capabilities.some((capability) =>
    capability.capabilityId === id && isFilePayloadObservationCapability(capability)));
}

function readHandoff(
  execution: RoleCapabilityExecution,
  params: Parameters<typeof projectFilePayloadContinuation>[0],
): Continuation | undefined {
  if (execution.status !== "settled" || execution.outcome !== "failed" || execution.observedEffect !== "none") return undefined;
  const envelope = record(execution.exactResult);
  if (envelope?.kind !== "generic_capability_result_v1" || envelope.authority !== "capability_adapter" || envelope.ok !== false) return undefined;
  const result = record(envelope.payload);
  if (result?.kind !== "runtime_capability_rejection_v1" || result.authority !== "runtime") return undefined;
  if (result.stage !== "before_external_execution" || result.code !== FILE_PAYLOAD_TOOL_REQUESTED) return undefined;
  const continuation = record(result.fileAuthoringContinuation);
  if (continuation?.kind !== FILE_PAYLOAD_TOOL_HANDOFF) return undefined;
  if (continuation.invocationAttempt !== execution.invocationAttempt) return undefined;
  if (!Number.isSafeInteger(continuation.steeringVersion) || (continuation.steeringVersion as number) < 0) return undefined;
  if (params.steeringVersion !== undefined && continuation.steeringVersion !== params.steeringVersion) return undefined;
  const pending = record(continuation.pending);
  if (pending?.capabilityId !== execution.capabilityId || typeof pending.authoringObjective !== "string" || !pending.authoringObjective.trim()) return undefined;
  const controls = record(pending.controls);
  if (!controls || typeof continuation.toolDecision !== "string") return undefined;
  try {
    if (!isDeepStrictEqual(controls, JSON.parse(execution.controlsJson))) return undefined;
    const toolCapabilityIds = readToolCapabilityIds(continuation.toolDecision);
    if (!toolCapabilityIds) return undefined;
    return {
      pending: { capabilityId: execution.capabilityId, authoringObjective: pending.authoringObjective, controls },
      toolDecision: continuation.toolDecision, toolCapabilityIds, phase: "tool",
      nextInvocationAttempt: execution.invocationAttempt + 1,
      observationToolsOnly: hasOnlyObservationToolCapabilities(toolCapabilityIds, params.capabilities),
    };
  } catch { return undefined; }
}

function readToolCapabilityIds(text: string): readonly string[] | undefined {
  const decision = record(record(JSON.parse(text))?.decision);
  if (!decision) return undefined;
  if (decision.action === "invoke_capability" && typeof decision.capabilityId === "string") return [decision.capabilityId];
  if (decision.action !== "invoke_capabilities" || !Array.isArray(decision.invocations)) return undefined;
  const ids = decision.invocations.map((entry) => record(entry)?.capabilityId);
  if (ids.length < 2 || ids.some((id) => typeof id !== "string")) return undefined;
  return ids as string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
