import { createHash } from "node:crypto";

import type { RoleOperationFingerprint } from "../role-calls/index.js";
import type { WorkerCapabilityControls } from "./contracts.js";
import { createStableWorkerCapabilityErrorFingerprint } from "./error-fingerprint.js";

type CanonicalValueResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false }>;

/**
 * Identifies one adapter preparation failure before an exact invocation exists.
 * The identity is intentionally conservative: unsupported input fails open,
 * and volatile orchestration metadata never becomes part of the action key.
 */
export function createWorkerCapabilityPreparationFailureFingerprint(input: {
  capabilityId: string;
  controls: WorkerCapabilityControls;
  workingDirectory?: string;
  error: unknown;
}): RoleOperationFingerprint | undefined {
  try {
    const controls = canonicalValue(input.controls);
    const errorFingerprint = createStableWorkerCapabilityErrorFingerprint({
      domain: "prepare",
      error: input.error,
    });
    if (!controls.ok || errorFingerprint === undefined) return undefined;

    const canonical = JSON.stringify([
      "worker_capability_preparation_failure_v1",
      input.capabilityId,
      input.workingDirectory ?? null,
      controls.value,
      errorFingerprint,
    ]);
    return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  } catch {
    return undefined;
  }
}

/**
 * Identifies one direct adapter invocation after its public controls have been
 * validated. Direct adapters have no later materialization boundary, so this
 * is their complete externally executable action identity.
 */
export function createWorkerCapabilityDirectActionFingerprint(input: {
  capabilityId: string;
  controls: WorkerCapabilityControls;
  workingDirectory?: string;
}): RoleOperationFingerprint | undefined {
  try {
    const controls = canonicalValue(input.controls);
    if (!controls.ok) return undefined;
    const canonical = JSON.stringify([
      "worker_capability_direct_action_v1",
      input.capabilityId,
      input.workingDirectory ?? null,
      controls.value,
    ]);
    return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  } catch {
    return undefined;
  }
}

function canonicalValue(value: unknown): CanonicalValueResult {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return Object.freeze({ ok: true as const, value });
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? Object.freeze({ ok: true as const, value })
      : Object.freeze({ ok: false as const });
  }
  if (value === undefined) {
    return Object.freeze({
      ok: true as const,
      value: Object.freeze(["undefined_v1"]),
    });
  }
  if (Array.isArray(value)) {
    const entries: unknown[] = [];
    for (const entry of value) {
      const canonical = canonicalValue(entry);
      if (!canonical.ok) return canonical;
      entries.push(canonical.value);
    }
    return Object.freeze({
      ok: true as const,
      value: Object.freeze(entries),
    });
  }
  if (!isPlainRecord(value)) return Object.freeze({ ok: false as const });

  const entries: (readonly [string, unknown])[] = [];
  for (const key of Object.keys(value).sort(compareText)) {
    const canonical = canonicalValue(value[key]);
    if (!canonical.ok) return canonical;
    entries.push(Object.freeze([key, canonical.value] as const));
  }
  return Object.freeze({
    ok: true as const,
    value: Object.freeze(entries),
  });
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
