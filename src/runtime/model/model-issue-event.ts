import { MODEL_ISSUE_EVENT, readModelIssue, type ModelIssueObserver } from "../../model-gateway/protocol/model-issue.js";

/** Runtime binds adapter facts to the owning invocation, then uses the normal event sink. */
export function modelIssueObserver(binding: Readonly<{
  requestId: string;
  invocationId: string;
  modelStep: string;
  onEvent?: (name: string, extra?: Record<string, unknown>) => void;
}>): ModelIssueObserver {
  return (value) => {
    const issue = readModelIssue(value);
    if (!issue || issue.outcome === "pending") return;
    binding.onEvent?.(MODEL_ISSUE_EVENT, {
      ...issue, requestId: binding.requestId,
      invocationId: binding.invocationId, modelStep: binding.modelStep,
    });
  };
}
