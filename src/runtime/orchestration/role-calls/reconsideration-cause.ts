import { ROLE_CAPABILITY_SELECTION_INVOCATION_LIMIT_MAX } from "./contracts.js";
import { exactKeys, isRecord } from "../../validation/strict-record.js";

export const ROLE_CAPABILITY_RECONSIDERATION_REASON_MAX_LENGTH = 320;
export const ROLE_CAPABILITY_RECONSIDERATION_STAGE_MAX_LENGTH = 128;
export const ROLE_CAPABILITY_RECONSIDERATION_ISSUE_CODE_MAX_LENGTH = 128;
export const ROLE_CAPABILITY_RECONSIDERATION_ISSUE_PATH_MAX_LENGTH = 512;
export const ROLE_CAPABILITY_RECONSIDERATION_ISSUE_LIMIT_MAX = 16;
export const ROLE_CAPABILITY_RECONSIDERATION_REPAIR_LIMIT_MAX = 16;

export type RoleCapabilityRefinementDecline = Readonly<{
  invocationIndex: number;
  reason: string;
}>;

export type RoleCapabilityRefinementValidationIssue = Readonly<{
  code: string;
  path: string;
}>;

export type RoleCapabilitySelectionReconsiderationCause =
  | Readonly<{
      kind: "refinement_declined";
      entries: readonly RoleCapabilityRefinementDecline[];
    }>
  | Readonly<{
      kind: "refinement_invalid_output";
      validationStage: string;
      issues: readonly RoleCapabilityRefinementValidationIssue[];
      repairAttempts: number;
      repeatedInvalidOutput: boolean;
    }>;

export function normalizeRoleCapabilitySelectionReconsiderationCause(
  input: unknown,
): RoleCapabilitySelectionReconsiderationCause | undefined {
  if (!isRecord(input) || typeof input.kind !== "string") return undefined;
  if (input.kind === "refinement_declined") {
    return normalizeRefinementDeclined(input);
  }
  if (input.kind === "refinement_invalid_output") {
    return normalizeRefinementInvalidOutput(input);
  }
  return undefined;
}

export function isReconsiderationCauseBoundToInvocationCount(
  input: unknown,
  invocationCount: number,
): boolean {
  const cause = normalizeRoleCapabilitySelectionReconsiderationCause(input);
  if (!cause || !Number.isSafeInteger(invocationCount)) return false;
  if (invocationCount < 1) return false;
  if (cause.kind === "refinement_invalid_output") return true;
  const indexes = cause.entries.map(({ invocationIndex }) => invocationIndex);
  const uniqueIndexes = new Set(indexes);
  return (
    uniqueIndexes.size === indexes.length &&
    indexes.every((index) => index < invocationCount)
  );
}

function normalizeRefinementDeclined(
  input: Record<string, unknown>,
):
  | Extract<
      RoleCapabilitySelectionReconsiderationCause,
      { kind: "refinement_declined" }
    >
  | undefined {
  if (!exactKeys(input, ["kind", "entries"])) return undefined;
  if (!Array.isArray(input.entries)) return undefined;
  if (
    input.entries.length < 1 ||
    input.entries.length > ROLE_CAPABILITY_SELECTION_INVOCATION_LIMIT_MAX
  ) {
    return undefined;
  }
  const entries = input.entries.map(normalizeRefinementDecline);
  if (entries.some((entry) => entry === undefined)) return undefined;
  return Object.freeze({
    kind: "refinement_declined" as const,
    entries: Object.freeze(entries as RoleCapabilityRefinementDecline[]),
  });
}

function normalizeRefinementDecline(
  input: unknown,
): RoleCapabilityRefinementDecline | undefined {
  if (!isRecord(input) || !exactKeys(input, ["invocationIndex", "reason"])) {
    return undefined;
  }
  if (!Number.isSafeInteger(input.invocationIndex)) return undefined;
  if ((input.invocationIndex as number) < 0) return undefined;
  const reason = normalizeBoundedText(
    input.reason,
    ROLE_CAPABILITY_RECONSIDERATION_REASON_MAX_LENGTH,
  );
  return reason
    ? Object.freeze({
        invocationIndex: input.invocationIndex as number,
        reason,
      })
    : undefined;
}

function normalizeRefinementInvalidOutput(
  input: Record<string, unknown>,
):
  | Extract<
      RoleCapabilitySelectionReconsiderationCause,
      { kind: "refinement_invalid_output" }
    >
  | undefined {
  if (
    !exactKeys(input, [
      "kind",
      "validationStage",
      "issues",
      "repairAttempts",
      "repeatedInvalidOutput",
    ])
  ) {
    return undefined;
  }
  const validationStage = normalizeBoundedText(
    input.validationStage,
    ROLE_CAPABILITY_RECONSIDERATION_STAGE_MAX_LENGTH,
  );
  const issues = normalizeValidationIssues(input.issues);
  const repairAttempts = input.repairAttempts;
  if (!validationStage || !issues) return undefined;
  if (!Number.isSafeInteger(repairAttempts)) return undefined;
  if (
    (repairAttempts as number) < 0 ||
    (repairAttempts as number) >
      ROLE_CAPABILITY_RECONSIDERATION_REPAIR_LIMIT_MAX
  ) {
    return undefined;
  }
  if (typeof input.repeatedInvalidOutput !== "boolean") return undefined;
  return Object.freeze({
    kind: "refinement_invalid_output" as const,
    validationStage,
    issues,
    repairAttempts: repairAttempts as number,
    repeatedInvalidOutput: input.repeatedInvalidOutput,
  });
}

function normalizeValidationIssues(
  input: unknown,
): readonly RoleCapabilityRefinementValidationIssue[] | undefined {
  if (!Array.isArray(input)) return undefined;
  if (input.length > ROLE_CAPABILITY_RECONSIDERATION_ISSUE_LIMIT_MAX) {
    return undefined;
  }
  const issues = input.map((entry) => {
    if (!isRecord(entry) || !exactKeys(entry, ["code", "path"])) {
      return undefined;
    }
    const code = normalizeBoundedText(
      entry.code,
      ROLE_CAPABILITY_RECONSIDERATION_ISSUE_CODE_MAX_LENGTH,
    );
    const path = normalizeBoundedTextAllowEmpty(
      entry.path,
      ROLE_CAPABILITY_RECONSIDERATION_ISSUE_PATH_MAX_LENGTH,
    );
    return code !== undefined && path !== undefined
      ? Object.freeze({ code, path })
      : undefined;
  });
  return issues.some((issue) => issue === undefined)
    ? undefined
    : Object.freeze(issues as RoleCapabilityRefinementValidationIssue[]);
}

function normalizeBoundedText(
  input: unknown,
  maximumLength: number,
): string | undefined {
  const normalized = normalizeBoundedTextAllowEmpty(input, maximumLength);
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeBoundedTextAllowEmpty(
  input: unknown,
  maximumLength: number,
): string | undefined {
  if (typeof input !== "string") return undefined;
  const normalized = input.trim();
  return normalized.length <= maximumLength ? normalized : undefined;
}
