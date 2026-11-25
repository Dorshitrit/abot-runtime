import { encodeModelIssues, MAX_MODEL_ISSUES_PER_INVOCATION, MODEL_ISSUE_HEADER, readModelIssue, type ModelIssueDiagnostic } from "../protocol/model-issue.js";
import type { GatewayResponse } from "./contracts.js";

/** Bounded metadata collector. Header for HTTP results; final facts for NDJSON streams. */
export class GatewayModelIssues {
  private readonly issues = new Map<string, ModelIssueDiagnostic>();

  readonly observe = (value: ModelIssueDiagnostic): void => {
    const issue = readModelIssue(value);
    if (!issue) return;
    const previous = this.issues.get(issue.issueId);
    if (previous && previous.outcome !== "pending") return;
    if (!previous && this.issues.size >= MAX_MODEL_ISSUES_PER_INVOCATION) return;
    this.issues.set(issue.issueId, previous ? { ...previous, outcome: issue.outcome } : issue);
  };

  writeHeader(response: GatewayResponse): void {
    const header = encodeModelIssues([...this.issues.values()]);
    if (header) response.setHeader(MODEL_ISSUE_HEADER, header);
  }

  writeStreamOutcomes(response: GatewayResponse): void {
    for (const issue of this.issues.values()) {
      if (issue.outcome !== "pending") response.write(`${JSON.stringify({ type: "diagnostic", diagnostic: issue })}\n`);
    }
  }
}
