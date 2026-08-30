import type { WorkerDecisionValidationIssue } from "../contracts.js";
import { createWorkerDecisionIssue } from "./validation-contract.js";

export function readWorkerDecisionRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function validateExactWorkerDecisionKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  issues: WorkerDecisionValidationIssue[],
  path = "decision",
): void {
  const expected = new Set(expectedKeys);
  const actual = Object.keys(record);
  const hasExpectedKeyCount = actual.length === expected.size;
  const containsOnlyExpectedKeys = actual.every((key) => expected.has(key));
  if (hasExpectedKeyCount && containsOnlyExpectedKeys) return;
  issues.push(createWorkerDecisionIssue("worker_decision_shape_invalid", path));
}

export function validateBoundedWorkerDecisionText(
  value: unknown,
  maximumLength: number,
  code: string,
  path: string,
  issues: WorkerDecisionValidationIssue[],
): void {
  if (hasValidBoundedWorkerDecisionText(value, maximumLength)) return;
  issues.push(createWorkerDecisionIssue(code, path));
}

function hasValidBoundedWorkerDecisionText(
  value: unknown,
  maximumLength: number,
): value is string {
  if (typeof value !== "string") return false;
  if (value.trim().length === 0) return false;
  return value.length <= maximumLength;
}
