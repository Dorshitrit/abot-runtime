import type { ChatMessage } from "../../../model-gateway/types.js";
import { projectCanonicalRequestToolResult } from "../../context/canonical-capability-result.js";
import type {
  RoleCallLedgerHead,
  RoleCapabilityExecution,
} from "../../orchestration/role-calls/index.js";

export const EXECUTION_CAPABILITY_RESULT_MESSAGE_KIND =
  "runtime_execution_capability_result_v1" as const;
export const EXECUTION_CAPABILITY_TOOL_NAME = "runtime_capability" as const;

/** One exact native result representation for active input and saved-source compatibility. */
export function buildExecutionCapabilityResultMessage(
  head: RoleCallLedgerHead,
  execution: RoleCapabilityExecution,
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
        summary: canonical.summary,
        adapterResult: execution.exactResult,
      },
    }),
    toolCallId: execution.executionId,
    toolName: EXECUTION_CAPABILITY_TOOL_NAME,
  });
}
