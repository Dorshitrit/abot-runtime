import { createHash } from "node:crypto";

import type { ToolCall } from "../../../../capabilities/tool-types.js";

/**
 * Hashes the exact normalized tool call. The runtime core receives only this
 * opaque identity and remains independent of tools, controls, and payloads.
 */
export function createRegisteredToolActionFingerprint(input: {
  contractVersion: number;
  operationId: string;
  call: ToolCall;
}): string {
  const canonical = JSON.stringify([
    "registered_tool_normal_invocation_v1",
    input.contractVersion,
    input.operationId,
    input.call.tool,
    canonicalEntries(input.call.params),
  ]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Identifies a fully bounded preparation attempt that could not become a
 * normalized tool call. The stable rejection code keeps it disjoint from a
 * later successful materialization of the same public controls.
 */
export function createRegisteredToolPreparationAttemptFingerprint(input: {
  operationId: string;
  controls: Readonly<Record<string, unknown>>;
  rejectionCode: string;
  payload?: string;
  materializedParams?: Readonly<Record<string, string>>;
}): string {
  const canonical = JSON.stringify([
    "operation_preparation_attempt_v1",
    input.operationId,
    canonicalEntries(input.controls),
    input.rejectionCode,
    input.payload === undefined ? null : digestText(input.payload),
    input.materializedParams === undefined
      ? null
      : Object.freeze(
          Object.entries(input.materializedParams)
            .sort(([left], [right]) => compareText(left, right))
            .map(([key, value]) =>
              Object.freeze([key, digestText(value)] as const),
            ),
        ),
  ]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalEntries(
  input: Readonly<Record<string, unknown>>,
): readonly (readonly [string, unknown])[] {
  return Object.freeze(
    Object.entries(input)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, value]) =>
        Object.freeze([key, canonicalValue(value)] as const),
      ),
  );
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => canonicalValue(entry)));
  }
  if (isPlainRecord(value)) return canonicalEntries(value);
  return value;
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
