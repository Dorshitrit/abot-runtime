import { isSourceIssueId } from "../../shared/source-issue.js";
import { readModelParameterOmissions, type ModelParameterOmission } from "./parameter-omissions.js";

export const MODEL_ISSUE_HEADER = "x-abot-model-issues";
export const MODEL_ISSUE_EVENT = "model.issue.observed";
export const MAX_MODEL_ISSUES_PER_INVOCATION = 4;

export type ModelIssueOutcome = "recovered" | "failed" | "interrupted";
export type ModelIssueDiagnostic = Readonly<{
  issueId: string;
  occurredAt: number;
  code: string;
  outcome: ModelIssueOutcome | "pending";
  profileId: string;
  providerId?: string;
  provider: string;
  model: string;
  operation: "chat" | "raw" | "input_tokens";
  parameter?: string;
  requestedValue?: string;
  recovery?: string;
  parameterOmissions?: readonly ModelParameterOmission[];
}>;
export type ModelIssueObservation = ModelIssueDiagnostic & { outcome: ModelIssueOutcome };
export type ModelIssueObserver = (issue: ModelIssueObservation) => void;

function bounded(value: unknown, limit = 160): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isDiagnosticProviderId(value: unknown): value is string {
  if (!bounded(value)) return false;
  // Configured names must also survive the URI-encoded diagnostic header.
  try { encodeURIComponent(value); return true; } catch { return false; }
}

/** Only internal adapter facts cross this boundary; arbitrary properties are dropped. */
export function readModelIssue(value: unknown): ModelIssueDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (!isSourceIssueId(input.issueId)) return undefined;
  if (!Number.isSafeInteger(input.occurredAt) || (input.occurredAt as number) < 0) return undefined;
  if (!bounded(input.code, 80) || !/^[a-z][a-z0-9_.-]*$/u.test(input.code)) return undefined;
  if (!["pending", "recovered", "failed", "interrupted"].includes(input.outcome as string)) return undefined;
  if (!["chat", "raw", "input_tokens"].includes(input.operation as string)) return undefined;
  if (!bounded(input.profileId) || !bounded(input.provider) || !bounded(input.model)) return undefined;
  if (input.providerId !== undefined && !isDiagnosticProviderId(input.providerId)) return undefined;
  const parameterOmissions = input.parameterOmissions === undefined ? undefined : readModelParameterOmissions(input.parameterOmissions);
  if (input.parameterOmissions !== undefined && parameterOmissions === undefined) return undefined;
  const optional: Record<string, string> = {};
  for (const key of ["parameter", "requestedValue", "recovery"] as const) {
    if (input[key] === undefined) continue;
    if (!bounded(input[key], 80) || !/^[a-zA-Z0-9_.:-]+$/u.test(input[key])) return undefined;
    optional[key] = input[key];
  }
  return Object.freeze({
    issueId: input.issueId, occurredAt: input.occurredAt as number,
    code: input.code, outcome: input.outcome as ModelIssueDiagnostic["outcome"],
    profileId: input.profileId, provider: input.provider, model: input.model,
    operation: input.operation as ModelIssueDiagnostic["operation"], ...optional,
    ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
    ...(parameterOmissions ? { parameterOmissions } : {}),
  });
}

export function encodeModelIssues(issues: readonly ModelIssueDiagnostic[]): string | undefined {
  const safe = issues.slice(0, MAX_MODEL_ISSUES_PER_INVOCATION).map(readModelIssue).filter(Boolean);
  return safe.length ? encodeURIComponent(JSON.stringify(safe)) : undefined;
}

export function decodeModelIssues(header: string | null): readonly ModelIssueDiagnostic[] {
  if (!header || header.length > 12_000) return [];
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(header));
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_MODEL_ISSUES_PER_INVOCATION).map(readModelIssue)
      .filter((issue): issue is ModelIssueDiagnostic => issue !== undefined);
  } catch { return []; }
}
