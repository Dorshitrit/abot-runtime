import { restoreRequestContextCompaction } from "../../context/semantic-compaction/snapshot.js";
import type { RequestContextCompactionSnapshot } from "../../context/semantic-compaction/snapshot.js";
import type { SemanticCompactionSource } from "../../context/semantic-compaction/contracts.js";
import {
  createRoleCallLedger,
  type RoleCapabilityExecution,
} from "../../orchestration/role-calls/index.js";
import type { RoleCallLedgerCheckpoint } from "../../orchestration/role-calls/checkpoint.js";
import type { CompiledRequestExecutionPolicy } from "../execution-scope.js";
import { traceDebug } from "../../observability/debug-logger.js";
import { createRequestRoleCallPolicy } from "../role-call-policy.js";
import {
  buildExecutionCapabilityResultMessage,
  EXECUTION_CAPABILITY_RESULT_MESSAGE_KIND,
  EXECUTION_CAPABILITY_TOOL_NAME,
} from "../../steps/execution-agent/capability-result-context.js";

/** Invalidate only proven legacy EA projections; the ledger retains the original evidence. */
export function restoreExecutionApprovalCompaction(params: {
  snapshot: RequestContextCompactionSnapshot;
  ledgerCheckpoint: RoleCallLedgerCheckpoint;
  requestId: string;
  executionPolicy: CompiledRequestExecutionPolicy;
}) {
  // Validate original hashes and complete checkpoint coverage before filtering anything.
  const restored = restoreRequestContextCompaction(params.snapshot);
  if (!usesExecutionAgentNativeResults(params.executionPolicy)) return restored;
  if (!params.snapshot.sources.some(isNativeResultCompatibilityCandidate))
    return restored;
  const ledger = createRoleCallLedger({
    requestId: params.requestId,
    policy: createRequestRoleCallPolicy(params.executionPolicy),
    checkpoint: params.ledgerCheckpoint,
  });
  const head = ledger.current();
  const executions = new Map(
    head.state.capabilityExecutions
      .filter((execution) => execution.callId === head.state.rootCallId)
      .map((execution) => [`tool-result:${execution.executionId}`, execution]),
  );
  const legacySourceRefs = new Set<string>();
  for (const source of params.snapshot.sources) {
    const execution = executions.get(source.sourceRef);
    if (!isExecutionResultSource(source, execution)) continue;
    if (!isSettledRootExecution(execution, head.state.rootCallId))
      throw new Error("context_compaction_snapshot_source_incompatible");
    const current = buildExecutionCapabilityResultMessage(head, execution);
    const matchesCurrentProjection = source.content === JSON.stringify(current);
    if (matchesCurrentProjection) continue;
    const matchesLegacyProjection =
      source.content === serializeLegacyExecutionResult(execution);
    if (!matchesLegacyProjection)
      throw new Error("context_compaction_snapshot_source_incompatible");
    legacySourceRefs.add(source.sourceRef);
  }
  if (legacySourceRefs.size === 0) return restored;
  const invalidatedCheckpoints = params.snapshot.checkpoints.filter(
    (checkpoint) =>
      checkpoint.sourceDigests.some((source) =>
        legacySourceRefs.has(source.sourceRef),
      ),
  );
  const ownsInvalidatedCheckpoints = invalidatedCheckpoints.every(
    (checkpoint) => checkpoint.requestId === params.requestId,
  );
  if (!ownsInvalidatedCheckpoints)
    throw new Error("context_compaction_snapshot_source_incompatible");
  const compatible = {
    ...params.snapshot,
    sources: params.snapshot.sources.filter(
      (source) => !legacySourceRefs.has(source.sourceRef),
    ),
    checkpoints: params.snapshot.checkpoints.filter(
      (checkpoint) => !invalidatedCheckpoints.includes(checkpoint),
    ),
  };
  const store = restoreRequestContextCompaction(compatible);
  traceDebug(
    "runtime.approvals",
    "compaction.legacy_execution_sources_invalidated",
    {
      requestId: params.requestId,
      sourceCount: legacySourceRefs.size,
      checkpointCount: invalidatedCheckpoints.length,
      scopeIds: invalidatedCheckpoints
        .slice(0, 8)
        .map(({ scopeId }) => scopeId),
      omittedScopeCount: Math.max(0, invalidatedCheckpoints.length - 8),
    },
  );
  return store;
}

function usesExecutionAgentNativeResults(
  policy: CompiledRequestExecutionPolicy,
): boolean {
  if (policy.authority.id !== "execution-agent-v1") return false;
  return policy.authority.rootContractId === "execution_agent";
}

function isSettledRootExecution(
  execution: RoleCapabilityExecution | undefined,
  rootCallId: string | null,
): execution is RoleCapabilityExecution {
  if (!execution) return false;
  if (execution.callId !== rootCallId) return false;
  return execution.status === "settled";
}

function isNativeResultCompatibilityCandidate(
  source: SemanticCompactionSource,
): boolean {
  if (source.sourceRef.startsWith("tool-result:")) return true;
  return hasExecutionResultEnvelope(source);
}

function isExecutionResultSource(
  source: SemanticCompactionSource,
  execution: RoleCapabilityExecution | undefined,
): boolean {
  if (execution) return true;
  return hasExecutionResultEnvelope(source);
}

function hasExecutionResultEnvelope(source: SemanticCompactionSource): boolean {
  try {
    const message = JSON.parse(source.content) as {
      role?: unknown;
      toolName?: unknown;
      content?: unknown;
    } | null;
    if (message?.role !== "tool") return false;
    if (message.toolName !== EXECUTION_CAPABILITY_TOOL_NAME) return false;
    if (typeof message.content !== "string") return false;
    const envelope = JSON.parse(message.content) as { kind?: unknown } | null;
    return envelope?.kind === EXECUTION_CAPABILITY_RESULT_MESSAGE_KIND;
  } catch {
    return false;
  }
}

/** Exact pre-canonical-outcome wire bytes, recognized only against the same ledger execution. */
function serializeLegacyExecutionResult(
  execution: RoleCapabilityExecution,
): string {
  return JSON.stringify({
    role: "tool",
    content: JSON.stringify({
      kind: EXECUTION_CAPABILITY_RESULT_MESSAGE_KIND,
      authority: "capability_adapter_result",
      presenceEffect: "runtime_result_only_not_user_intent",
      invocationAttempt: execution.invocationAttempt,
      result: {
        executionId: execution.executionId,
        capabilityId: execution.capabilityId,
        adapterResult: execution.exactResult,
      },
    }),
    toolCallId: execution.executionId,
    toolName: EXECUTION_CAPABILITY_TOOL_NAME,
  });
}
