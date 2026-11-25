import { randomUUID } from "node:crypto";
import type { ModelIssueDiagnostic, ModelIssueOutcome } from "../../protocol/model-issue.js";
import type { ResolvedModelInvocation } from "../../types.js";

/** Adapter-owned facts: the original rejection is one occurrence regardless of retry outcome. */
export class OpenAIReasoningIssue {
  private settled = false;
  private readonly diagnostic: ModelIssueDiagnostic;

  constructor(invocation: ResolvedModelInvocation, effort: string,
    operation: ModelIssueDiagnostic["operation"],
    private readonly observe?: (issue: ModelIssueDiagnostic) => void,
  ) {
    this.diagnostic = {
      issueId: randomUUID(), occurredAt: Date.now(), code: "model_reasoning_rejected",
      outcome: "pending", profileId: invocation.profile.id,
      providerId: invocation.profile.providerId, provider: invocation.profile.provider,
      model: invocation.model, operation, parameter: "reasoning_effort",
      requestedValue: effort, recovery: "provider_default",
    };
    this.emit(this.diagnostic);
  }

  finish(outcome: ModelIssueOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.emit({ ...this.diagnostic, outcome });
  }

  private emit(issue: ModelIssueDiagnostic): void {
    try { this.observe?.(issue); } catch { /* Diagnostics do not change retry behavior. */ }
  }
}
