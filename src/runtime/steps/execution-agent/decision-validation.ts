import {
  EXECUTION_AGENT_ACKNOWLEDGEMENT_MAX_LENGTH,
  EXECUTION_AGENT_TITLE_MAX_LENGTH,
  EXECUTION_AGENT_OBJECTIVE_MAX_LENGTH,
  EXECUTION_AGENT_DECISION_ACTIONS,
  type ExecutionAgentDecisionAction,
  type ExecutionAgentDecisionParseResult,
  type ExecutionAgentDecisionPresentation,
  type ExecutionAgentDecisionValidationIssue,
} from "./contracts.js";
import type { PreparedExecutionAgentDecisionContract } from "./format.js";

export function parsePresentation(
  record: Record<string, unknown>,
  contract: PreparedExecutionAgentDecisionContract,
  issues: ExecutionAgentDecisionValidationIssue[],
): ExecutionAgentDecisionPresentation {
  const acknowledgement = contract.includeAcknowledgement
    ? validateBoundedText({
        value: record.acknowledgement,
        minimumLength: 2,
        maximumLength: EXECUTION_AGENT_ACKNOWLEDGEMENT_MAX_LENGTH,
        code: "execution_agent_acknowledgement_invalid",
        path: "decision.acknowledgement",
        label: "Acknowledgement",
        issues,
      })
    : undefined;
  const title = contract.includeTitle
    ? validateBoundedText({
        value: record.title,
        minimumLength: 2,
        maximumLength: EXECUTION_AGENT_TITLE_MAX_LENGTH,
        code: "execution_agent_title_invalid",
        path: "decision.title",
        label: "Title",
        issues,
      })
    : undefined;
  return {
    ...(contract.includeAcknowledgement && acknowledgement !== undefined
      ? { acknowledgement }
      : {}),
    ...(contract.includeTitle && title !== undefined ? { title } : {}),
  };
}

export function presentationKeys(
  contract: PreparedExecutionAgentDecisionContract,
): readonly string[] {
  return [
    ...(contract.includeAcknowledgement ? ["acknowledgement"] : []),
    ...(contract.includeTitle ? ["title"] : []),
  ];
}

export function exactPresentationKeys(
  record: Record<string, unknown>,
  contract: PreparedExecutionAgentDecisionContract,
  actionKeys: readonly string[],
  issues: ExecutionAgentDecisionValidationIssue[],
): void {
  exactKeys(
    record,
    [...actionKeys, ...presentationKeys(contract)],
    issues,
    "decision",
  );
}

export function validateObjective(
  value: unknown,
  issues: ExecutionAgentDecisionValidationIssue[],
): string | undefined {
  return validateBoundedText({
    value,
    maximumLength: EXECUTION_AGENT_OBJECTIVE_MAX_LENGTH,
    code: "execution_agent_objective_invalid",
    path: "decision.objective",
    label: "Objective",
    issues,
  });
}

export function parseBoundedTextArray(
  params: Readonly<{
    value: unknown;
    path: string;
    code: string;
    label: string;
    itemMaximumLength: number;
    maximumItems: number;
    issues: ExecutionAgentDecisionValidationIssue[];
  }>,
): readonly string[] | undefined {
  if (
    !Array.isArray(params.value) ||
    params.value.length < 1 ||
    params.value.length > params.maximumItems
  ) {
    params.issues.push(
      issue(
        params.code,
        params.path,
        `${params.label} must contain 1-${params.maximumItems} entries.`,
      ),
    );
    return undefined;
  }
  const normalized: string[] = [];
  params.value.forEach((value, index) => {
    const accepted = validateBoundedText({
      value,
      maximumLength: params.itemMaximumLength,
      code: params.code,
      path: `${params.path}.${index}`,
      label: params.label,
      issues: params.issues,
    });
    if (accepted !== undefined) normalized.push(accepted);
  });
  if (new Set(normalized).size !== normalized.length) {
    params.issues.push(
      issue(
        params.code,
        params.path,
        `${params.label} entries must be distinct.`,
      ),
    );
  }
  return normalized.length === params.value.length
    ? Object.freeze(normalized)
    : undefined;
}

export function validateBoundedText(
  params: Readonly<{
    value: unknown;
    minimumLength?: number;
    maximumLength: number;
    code: string;
    path: string;
    label: string;
    issues: ExecutionAgentDecisionValidationIssue[];
  }>,
): string | undefined {
  const normalized =
    typeof params.value === "string" ? params.value.trim() : "";
  const minimumLength = params.minimumLength ?? 1;
  if (
    typeof params.value !== "string" ||
    normalized.length < minimumLength ||
    params.value.length > params.maximumLength
  ) {
    params.issues.push(
      issue(
        params.code,
        params.path,
        `${params.label} must be text of ${minimumLength}-${params.maximumLength} characters.`,
      ),
    );
    return undefined;
  }
  return normalized;
}

export function readAction(
  value: unknown,
): ExecutionAgentDecisionAction | undefined {
  return typeof value === "string" &&
    EXECUTION_AGENT_DECISION_ACTIONS.includes(
      value as ExecutionAgentDecisionAction,
    )
    ? (value as ExecutionAgentDecisionAction)
    : undefined;
}

export function exactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  issues: ExecutionAgentDecisionValidationIssue[],
  path: string,
): void {
  const expected = new Set(expectedKeys);
  const actual = Object.keys(record);
  if (
    actual.length !== expected.size ||
    actual.some((key) => !expected.has(key))
  ) {
    issues.push(
      issue(
        "execution_agent_decision_shape_invalid",
        path,
        "Decision fields must exactly match the selected action.",
      ),
    );
  }
}

export function rejectEnvelope(
  issues: readonly ExecutionAgentDecisionValidationIssue[],
): ExecutionAgentDecisionParseResult {
  return {
    ok: false,
    stage: "json_envelope",
    issues: Object.freeze([...issues]),
  };
}

export function issue(
  code: string,
  path: string,
  message: string,
): ExecutionAgentDecisionValidationIssue {
  return { code, path, message };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
