import { randomUUID } from "node:crypto";
import type { ToolRequestPreparationContext } from "../../../src/capabilities/tool-request-resources.js";
import { fail } from "../../filesystem/source/errors.js";

export type ObservedRange = Readonly<{
  id: string; path: string; targetPath: string; version: string; start: number; end: number; text: string;
}>;
export type PayloadBinding = Readonly<{
  id: string; path: string; version: string; mode: "create" | "exact" | "range";
  start?: number; end?: number; bodyDigest?: string;
}>;
const STATE_KEY = "filesystem-ea.v1";
const MAX_RANGES = 32;
const MAX_BINDINGS = 128;
const MAX_STATE_BYTES = 1_048_576;

/** Request-owned opaque references; no disk sidecar and no global cache. */
export function createRangeReferences(context?: ToolRequestPreparationContext) {
  if (!context?.requestId) invalidState();
  const requestId = context.requestId;
  let closed = false;
  const assertOpen = () => { if (closed) fail("ea_request_closed", "This file request has ended."); };
  const ranges = new Map<string, ObservedRange>();
  const bindings = new Map<string, PayloadBinding>();
  const restored = context?.requestState?.read(STATE_KEY);
  if (restored !== undefined) {
    if (!isRecord(restored) || restored.version !== 1 || restored.requestId !== requestId ||
      !Array.isArray(restored.ranges) || !Array.isArray(restored.bindings) ||
      restored.ranges.length > MAX_RANGES || restored.bindings.length > MAX_BINDINGS ||
      Buffer.byteLength(JSON.stringify(restored)) > MAX_STATE_BYTES) invalidState();
    for (const range of restored.ranges) {
      if (!isRecord(range) || !validBase(range) || !validOffsets(range) ||
        typeof range.targetPath !== "string" || !range.targetPath.length || range.targetPath.length > 4096 ||
        typeof range.text !== "string" || range.text.length !== Number(range.end) - Number(range.start) ||
        Buffer.byteLength(range.text) > 24_000) invalidState();
      if (ranges.has(range.id as string)) invalidState();
      ranges.set(range.id as string, Object.freeze(range as ObservedRange));
    }
    for (const binding of restored.bindings) {
      if (!isRecord(binding) || !validBase(binding) ||
        !["create", "exact", "range"].includes(String(binding.mode)) ||
        (binding.mode === "range" && !validOffsets(binding)) ||
        (binding.bodyDigest !== undefined && !/^[a-f0-9]{64}$/.test(String(binding.bodyDigest)))) invalidState();
      if (bindings.has(binding.id as string)) invalidState();
      bindings.set(binding.id as string, Object.freeze(binding as PayloadBinding));
    }
  }
  const dispose = () => { closed = true; ranges.clear(); bindings.clear(); };
  const snapshot = () => ({ version: 1, requestId, ranges: [...ranges.values()], bindings: [...bindings.values()] });
  const reservedBytes = () => Buffer.byteLength(JSON.stringify(snapshot())) +
    [...bindings.values()].filter((binding) => binding.bodyDigest === undefined).length * 80;
  if (reservedBytes() > MAX_STATE_BYTES) invalidState();
  context?.requestState?.register(STATE_KEY, { snapshot, dispose });
  if (!context?.requestState) context?.onRequestDispose?.(dispose);

  return Object.freeze({
    observe(input: Omit<ObservedRange, "id">): string {
      assertOpen();
      while (ranges.size >= MAX_RANGES) ranges.delete(ranges.keys().next().value!);
      const id = `range:${randomUUID()}`;
      ranges.set(id, Object.freeze({ ...input, id }));
      while (reservedBytes() > MAX_STATE_BYTES) {
        ranges.delete(ranges.keys().next().value!);
      }
      if (!ranges.has(id)) fail("ea_request_state_limit", "The request has no room for another exact file window.");
      return id;
    },
    resolve(id: string, path: string, version: string): ObservedRange {
      assertOpen();
      const range = ranges.get(id);
      if (!range || range.path !== path) fail("ea_range_invalid", "The range reference is not available for this request and path. Read the desired range again.");
      if (range.version !== version) fail("filesystem_target_changed", "The file changed after the range was read. Read it again.");
      return range;
    },
    bind(input: Omit<PayloadBinding, "id">): PayloadBinding {
      assertOpen();
      if (bindings.size >= MAX_BINDINGS) fail("ea_binding_limit", "The request reached its prepared file edit limit.");
      const binding = Object.freeze({ ...input, id: `payload:${randomUUID()}` });
      bindings.set(binding.id, binding);
      if (reservedBytes() > MAX_STATE_BYTES) {
        bindings.delete(binding.id);
        fail("ea_request_state_limit", "The request has no room for another prepared file edit.");
      }
      return binding;
    },
    seal(id: string, bodyDigest: string): void {
      assertOpen();
      const binding = bindings.get(id);
      if (!binding || binding.bodyDigest !== undefined) fail("ea_payload_binding_invalid", "The source binding is unavailable or already used.");
      bindings.set(id, Object.freeze({ ...binding, bodyDigest }));
    },
    payload(id: string): PayloadBinding {
      assertOpen();
      const binding = bindings.get(id);
      if (!binding) fail("ea_payload_binding_invalid", "The prepared payload is not owned by this request.");
      return binding;
    },
    forget(id: string): void { bindings.delete(id); },
  });
}
export type RangeReferences = ReturnType<typeof createRangeReferences>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validBase(value: Record<string, unknown>): boolean {
  return ["id", "path", "version"].every((key) =>
    typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 8192);
}
function validOffsets(value: Record<string, unknown>): boolean {
  return Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) &&
    Number(value.start) >= 0 && Number(value.end) >= Number(value.start) && Number(value.end) <= 1_048_576;
}
function invalidState(): never { return fail("ea_request_state_invalid", "The saved EA file state is invalid."); }
