import { randomUUID } from "node:crypto";
import type { ToolRequestPreparationContext } from "../../../src/capabilities/tool-request-resources.js";
import { fail } from "../../filesystem/source/errors.js";
import { sameSourceVersion } from "./source-version.js";

export type ObservedRange = Readonly<{
  id: string; path: string; targetPath: string; version: string; start: number; end: number; text: string;
}>;
export type CommittedRange = Readonly<Omit<ObservedRange, "text"> & { origin: "committed_edit" }>;
type StoredRange = ObservedRange | CommittedRange;
export type CommittedRangeReservation = Readonly<{
  id: string;
  commit(version: string): void;
  cancel(): void;
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
  const ranges = new Map<string, StoredRange>();
  const reservations = new Map<string, Readonly<{ bytes: number; bindingId: string }>>();
  const bindings = new Map<string, PayloadBinding>();
  const restored = context?.requestState?.read(STATE_KEY);
  if (restored !== undefined) {
    if (!isRecord(restored) || !isSupportedStateVersion(restored.version) || restored.requestId !== requestId ||
      !Array.isArray(restored.ranges) || !Array.isArray(restored.bindings) ||
      restored.ranges.length > MAX_RANGES || restored.bindings.length > MAX_BINDINGS ||
      Buffer.byteLength(JSON.stringify(restored)) > MAX_STATE_BYTES) invalidState();
    for (const range of restored.ranges) {
      if (!isRecord(range) || !validBase(range) || !validOffsets(range) ||
        typeof range.targetPath !== "string" || !range.targetPath.length || range.targetPath.length > 4096 ||
        !hasSupportedRangeSource(range, restored.version)) invalidState();
      if (ranges.has(range.id as string)) invalidState();
      ranges.set(range.id as string, Object.freeze(range as StoredRange));
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
  const dispose = () => { closed = true; ranges.clear(); reservations.clear(); bindings.clear(); };
  const snapshot = () => ({ version: 2, requestId, ranges: [...ranges.values()], bindings: [...bindings.values()] });
  const reservedBytes = () => {
    const current = Buffer.byteLength(JSON.stringify(snapshot())) +
      [...bindings.values()].filter((binding) => binding.bodyDigest === undefined).length * 80;
    const future = [...reservations.values()].reduce((total, reservation) => {
      const binding = bindings.get(reservation.bindingId);
      return total + reservation.bytes - (binding ? Buffer.byteLength(JSON.stringify(binding)) : 0);
    }, current);
    return Math.max(current, future);
  };
  const evictOldestRange = () => {
    const oldest = ranges.keys().next().value;
    if (oldest === undefined) fail("ea_request_state_limit", "The request has no room for another exact file window.");
    ranges.delete(oldest);
  };
  if (reservedBytes() > MAX_STATE_BYTES) invalidState();
  context?.requestState?.register(STATE_KEY, { snapshot, dispose });
  if (!context?.requestState) context?.onRequestDispose?.(dispose);

  return Object.freeze({
    observe(input: Omit<ObservedRange, "id">): string {
      assertOpen();
      while (ranges.size + reservations.size >= MAX_RANGES) evictOldestRange();
      const id = `range:${randomUUID()}`;
      ranges.set(id, Object.freeze({ ...input, id }));
      while (reservedBytes() > MAX_STATE_BYTES) {
        evictOldestRange();
      }
      if (!ranges.has(id)) fail("ea_request_state_limit", "The request has no room for another exact file window.");
      return id;
    },
    reserveCommitted(input: Omit<CommittedRange, "id" | "version" | "origin">,
      bindingId: string): CommittedRangeReservation {
      assertOpen();
      if (!validOffsets(input)) invalidState();
      const binding = bindings.get(bindingId);
      if (!binding) fail("ea_payload_binding_invalid", "The prepared payload is not owned by this request.");
      const id = `range:${randomUUID()}`;
      const entry = { ...input, id, origin: "committed_edit" as const };
      // Post-write inode/time/size digits may grow; no body bytes are retained.
      const bytes = Buffer.byteLength(JSON.stringify({ ...entry, version: binding.version })) + 256;
      reservations.set(id, { bytes, bindingId });
      const rangeBytes = [...ranges.values()].reduce((total, range) => total + Buffer.byteLength(JSON.stringify(range)), 0);
      if (reservations.size > MAX_RANGES || reservedBytes() - rangeBytes > MAX_STATE_BYTES) {
        reservations.delete(id);
        fail("ea_request_state_limit", "The request has no room for another exact file window.");
      }
      return Object.freeze({ id,
        commit(version: string) {
          assertOpen();
          const committed = { ...entry, version };
          const capacity = reservations.get(id)?.bytes;
          if (capacity === undefined || Buffer.byteLength(JSON.stringify(committed)) + 1 > capacity)
            fail("ea_request_state_limit", "The committed file reference exceeds its reserved capacity.");
          reservations.delete(id);
          while (ranges.size + reservations.size >= MAX_RANGES) evictOldestRange();
          ranges.set(id, Object.freeze(committed));
          while (reservedBytes() > MAX_STATE_BYTES) evictOldestRange();
          if (!ranges.has(id)) fail("ea_request_state_limit", "The committed file reference could not be retained.");
        },
        cancel() { reservations.delete(id); },
      });
    },
    resolve(id: string, path: string, version: string): StoredRange {
      assertOpen();
      const range = ranges.get(id);
      assertRangeReferenceForPath(range, path);
      if (!sameSourceVersion(range.version, version)) fail("filesystem_target_changed", "The file changed after the range was read. Read it again.");
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

function assertRangeReferenceForPath(range: StoredRange | undefined, path: string): asserts range is StoredRange {
  if (!range) fail("ea_range_invalid", "The range reference is not available for this request. Read the desired range again.");
  if (range.path !== path)
    fail("ea_range_invalid", "The range reference belongs to a different path. Read the desired range from the selected file and use its range_ref.");
}

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
function hasSupportedRangeSource(value: Record<string, unknown>, stateVersion: unknown): boolean {
  if (value.origin === "committed_edit") {
    if (stateVersion !== 2) return false;
    if (Object.hasOwn(value, "text")) return false;
    return Number(value.end) - Number(value.start) <= 262_144;
  }
  if (value.origin !== undefined) return false;
  if (typeof value.text !== "string") return false;
  if (value.text.length !== Number(value.end) - Number(value.start)) return false;
  return Buffer.byteLength(value.text) <= 24_000;
}
function isSupportedStateVersion(version: unknown): boolean {
  return version === 1 || version === 2;
}
function invalidState(): never { return fail("ea_request_state_invalid", "The saved EA file state is invalid."); }
