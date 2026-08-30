import { createHash } from "node:crypto";

import type { RoleOperationOutcomeFingerprint } from "../role-calls/index.js";
import { createStableWorkerCapabilityErrorFingerprint } from "./error-fingerprint.js";

/**
 * Keeps thrown adapter failures distinct without persisting their raw values.
 * Unsafe or unstable thrown values deliberately produce no tracking identity.
 */
export function createWorkerCapabilityExecutionErrorOutcomeFingerprint(
  error: unknown,
): RoleOperationOutcomeFingerprint | undefined {
  return createStableWorkerCapabilityErrorFingerprint({
    domain: "execute",
    error,
  });
}

/** Keeps distinct adapter contract violations separate without exposing them. */
export function createWorkerCapabilityResultRejectionOutcomeFingerprint(
  issueCode: string,
): RoleOperationOutcomeFingerprint {
  return digest(["adapter_result_rejection_v1", issueCode]);
}

function digest(value: unknown): RoleOperationOutcomeFingerprint {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}
