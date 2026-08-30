import { createHash } from "node:crypto";

import type { CapabilityAdapterResult } from "../../orchestration/capability-adapters/index.js";
import type { RoleOperationOutcomeFingerprint } from "../../orchestration/role-calls/index.js";

/**
 * Owns stable failure interpretation for the registered-tool adapter. The
 * generic capability engine receives only the resulting opaque identity.
 */
export function createRegisteredToolWorkerFailureOutcomeFingerprint(
  exactResult: CapabilityAdapterResult,
): RoleOperationOutcomeFingerprint | null {
  try {
    if (exactResult.kind === "runtime_capability_rejection_v1") {
      return digest([
        "registered_tool_runtime_rejection_v1",
        exactResult.stage,
        exactResult.code,
      ]);
    }
    if (exactResult.kind === "registered_tool_execution_result_v1") {
      const discriminants = registeredToolFailureDiscriminants(
        exactResult.result,
      );
      if (discriminants.length > 0) {
        return digest(["registered_tool_execution_failure_v1", discriminants]);
      }
    }
    return digest([
      "registered_tool_canonical_failure_v1",
      canonicalValue(exactResult),
    ]);
  } catch {
    return null;
  }
}

function digest(value: unknown): RoleOperationOutcomeFingerprint {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function registeredToolFailureDiscriminants(input: {
  errorCode?: string;
  exitCode?: number;
}): readonly (readonly [string, string | number])[] {
  const discriminants: (readonly [string, string | number])[] = [];
  const errorCode = input.errorCode?.trim();
  if (errorCode) {
    discriminants.push(Object.freeze(["error_code", errorCode] as const));
  }
  if (input.exitCode !== undefined) {
    if (!Number.isFinite(input.exitCode)) {
      throw new Error("registered_tool_failure_exit_code_invalid");
    }
    discriminants.push(Object.freeze(["exit_code", input.exitCode] as const));
  }
  return Object.freeze(discriminants);
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("registered_tool_failure_number_invalid");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => canonicalValue(entry)));
  }
  if (!isPlainRecord(value)) {
    throw new Error("registered_tool_failure_value_invalid");
  }
  return Object.freeze(
    Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) =>
        Object.freeze([key, canonicalValue(entry)] as const),
      ),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
