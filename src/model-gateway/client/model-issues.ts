import { attachSourceIssueId } from "../../shared/source-issue.js";
import { ModelGatewayInvocationError } from "./invocation-error.js";
import { decodeModelIssues, MAX_MODEL_ISSUES_PER_INVOCATION, MODEL_ISSUE_HEADER, readModelIssue, type ModelIssueDiagnostic, type ModelIssueObserver, type ModelIssueOutcome } from "../protocol/model-issue.js";

/** Finalizes only observed issues; reconnects, content, and retries create no new IDs. */
export class ClientModelIssues {
  private readonly issues = new Map<string, ModelIssueDiagnostic>();
  constructor(private readonly observer?: ModelIssueObserver) {}

  readHeader(response: Response): void {
    for (const issue of decodeModelIssues(response.headers?.get(MODEL_ISSUE_HEADER) ?? null)) this.observe(issue);
  }

  readonly observe = (value: unknown): void => {
    const issue = readModelIssue(value);
    if (!issue) return;
    const previous = this.issues.get(issue.issueId);
    if (previous && previous.outcome !== "pending") return;
    if (!previous && this.issues.size >= MAX_MODEL_ISSUES_PER_INVOCATION) return;
    this.issues.set(issue.issueId, previous ? { ...previous, outcome: issue.outcome } : issue);
  };

  finish(fallback: ModelIssueOutcome, error?: unknown): void {
    for (const issue of this.issues.values()) {
      // Missing terminal provider evidence cannot establish recovery from HTTP 200.
      const outcome = issue.outcome === "pending" ? (fallback === "recovered" ? "interrupted" : fallback) : issue.outcome;
      if (error instanceof ModelGatewayInvocationError && outcome !== "recovered") attachSourceIssueId(error, issue.issueId);
      try { this.observer?.({ ...issue, outcome }); } catch { /* Passive diagnostics cannot fail model execution. */ }
    }
    this.issues.clear();
  }

  bindFailure<T extends Error>(error: T): T {
    for (const issue of this.issues.values()) {
      if (issue.outcome !== "recovered") attachSourceIssueId(error, issue.issueId);
    }
    return error;
  }
}

export async function withModelIssues<T>(
  observer: ModelIssueObserver | undefined,
  abortSignal: AbortSignal,
  invoke: (issues: ClientModelIssues) => Promise<T>,
): Promise<T> {
  const issues = new ClientModelIssues(observer);
  try {
    const result = await invoke(issues);
    issues.finish(abortSignal.aborted ? "interrupted" : "recovered");
    return result;
  } catch (error) {
    issues.finish(abortSignal.aborted ? "interrupted" : "failed", error);
    throw error;
  }
}
