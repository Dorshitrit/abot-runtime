import type { ChatMessage } from "../../../model-gateway/types.js";
import { projectCanonicalRequestToolResult } from "../../context/canonical-capability-result.js";
import {
  createSemanticCompactionSha256Fingerprint,
  type SemanticCompactionSource,
} from "../../context/semantic-compaction/contracts.js";
import type {
  RoleCallLedgerHead,
  RoleCapabilityExecution,
} from "../../orchestration/role-calls/index.js";

export const EXECUTION_CAPABILITY_RESULT_MESSAGE_KIND =
  "runtime_execution_capability_result_v1" as const;
export const EXECUTION_CAPABILITY_TOOL_NAME = "runtime_capability" as const;

/** Canonical bytes stay stable; only the model view may omit an exact duplicate. */
export function buildExecutionCapabilityResultMessage(
  head: RoleCallLedgerHead,
  execution: RoleCapabilityExecution,
  projection: "canonical" | "model" = "canonical",
): ChatMessage {
  if (execution.status !== "settled" || execution.exactResult === undefined) {
    throw new Error("execution_agent_continuation_result_invalid");
  }
  const canonical = projectCanonicalRequestToolResult(head, execution);
  return Object.freeze({
    role: "tool" as const,
    content: JSON.stringify({
      kind: EXECUTION_CAPABILITY_RESULT_MESSAGE_KIND,
      authority: "canonical_role_call_ledger",
      presenceEffect: "runtime_result_only_not_user_intent",
      invocationAttempt: execution.invocationAttempt,
      result: {
        executionId: execution.executionId,
        capabilityId: execution.capabilityId,
        outcome: canonical.outcome,
        observedEffect: canonical.observedEffect,
        ...(canOmitDuplicateSummary(projection, canonical)
          ? {}
          : { summary: canonical.summary }),
        adapterResult: execution.exactResult,
      },
    }),
    toolCallId: execution.executionId,
    toolName: EXECUTION_CAPABILITY_TOOL_NAME,
  });
}

/** Reuse the original native-message identity for compaction and approval resume. */
export function buildExecutionCapabilityResultSource(
  head: RoleCallLedgerHead,
  execution: RoleCapabilityExecution,
): SemanticCompactionSource {
  const content = JSON.stringify(
    buildExecutionCapabilityResultMessage(head, execution),
  );
  return Object.freeze({
    sourceRef: `tool-result:${execution.executionId}`,
    sourceFingerprint: createSemanticCompactionSha256Fingerprint(content),
    content,
  });
}

function canOmitDuplicateSummary(
  projection: "canonical" | "model",
  result: ReturnType<typeof projectCanonicalRequestToolResult>,
): boolean {
  if (projection !== "model") return false;
  if (result.adapterResult?.kind !== "registered_tool_execution_result_v1")
    return false;
  return result.summary === result.adapterResult.result.output;
}
