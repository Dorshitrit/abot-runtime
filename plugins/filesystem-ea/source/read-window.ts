import { readRequiredString } from "../../../src/plugin-sdk/index.js";
import { fail } from "../../filesystem/source/errors.js";
import { lineAt } from "./snapshot.js";

const MAX_READ_BYTES = 24_000;
const DEFAULT_READ_LINES = 120;
type ByteRange = Readonly<{ start_byte: number; end_byte: number; next_byte?: number }>;
type ReadWindow = Readonly<{
  start: number; end: number; text: string; startLine: number; totalLines: number;
  truncated: boolean; complete: boolean; byteRange?: ByteRange; totalBytes?: number;
}>;

export function selectReadWindow(content: string, params: Record<string, unknown>): ReadWindow {
  if (hasByteSelection(params)) return selectByteWindow(content, params);
  const defaultByteBudget = readDefaultByteBudget(params);
  if (hasLineSelection(params)) return selectLineWindow(content, params);
  return selectLineWindow(content, { ...params, start_line: 1, end_line: DEFAULT_READ_LINES }, defaultByteBudget);
}

function hasLineSelection(params: Record<string, unknown>): boolean {
  if (params.start_line !== undefined) return true;
  if (params.end_line !== undefined) return true;
  return params.locator !== undefined;
}

function hasByteSelection(params: Record<string, unknown>): boolean {
  return params.start_byte !== undefined;
}

function readDefaultByteBudget(params: Record<string, unknown>): number {
  if (params.max_bytes === undefined) return MAX_READ_BYTES;
  assertByteControlsAreExclusive(params);
  return readByteWindowInteger(params.max_bytes, 1, MAX_READ_BYTES, "max_bytes");
}

function selectByteWindow(content: string, params: Record<string, unknown>): ReadWindow {
  assertByteControlsAreExclusive(params);
  const bytes = Buffer.from(content, "utf8");
  const startByte = readByteWindowInteger(params.start_byte, 0, bytes.length, "start_byte");
  const maxBytes = readByteWindowInteger(params.max_bytes === undefined ? MAX_READ_BYTES : params.max_bytes,
    1, MAX_READ_BYTES, "max_bytes");
  assertUtf8StartBoundary(bytes, startByte);
  const endByte = utf8WindowEnd(bytes, Math.min(bytes.length, startByte + maxBytes));
  assertByteWindowMakesProgress(startByte, endByte, bytes.length);
  const text = bytes.subarray(startByte, endByte).toString("utf8");
  // Existing range references use JavaScript string offsets, not byte offsets.
  const start = bytes.subarray(0, startByte).toString("utf8").length;
  return {
    start, end: start + text.length, text, startLine: lineAt(content, start),
    totalLines: lineAt(content, content.length), truncated: false,
    complete: startByte === 0 && endByte === bytes.length, totalBytes: bytes.length,
    byteRange: { start_byte: startByte, end_byte: endByte,
      ...(endByte < bytes.length ? { next_byte: endByte } : {}) },
  };
}

function assertByteControlsAreExclusive(params: Record<string, unknown>): void {
  for (const key of ["start_line", "end_line", "locator", "context_lines"]) {
    if (params[key] !== undefined)
      fail("ea_read_range_invalid", "Byte controls cannot be combined with explicit line or locator controls.");
  }
}

function readByteWindowInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value)) fail("ea_read_range_invalid", `${name} must be an integer.`);
  const result = Number(value);
  if (result < minimum || result > maximum)
    fail("ea_read_range_invalid", `${name} must be between ${minimum} and ${maximum}.`);
  return result;
}

function assertByteWindowMakesProgress(start: number, end: number, fileBytes: number): void {
  if (end > start) return;
  if (start === fileBytes) return;
  fail("ea_read_range_invalid", "max_bytes is too small for the next UTF-8 character.");
}

function assertUtf8StartBoundary(bytes: Buffer, start: number): void {
  if (isUtf8ContinuationByte(bytes, start))
    fail("ea_read_range_invalid", "start_byte must be a UTF-8 character boundary; use a returned next_byte.");
}

function isUtf8ContinuationByte(bytes: Buffer, offset: number): boolean {
  if (offset >= bytes.length) return false;
  return (bytes[offset]! & 0xc0) === 0x80;
}

function utf8WindowEnd(bytes: Buffer, end: number): number {
  while (isUtf8ContinuationByte(bytes, end)) end--;
  return end;
}

function selectLineWindow(content: string, params: Record<string, unknown>, maxBytes = MAX_READ_BYTES): ReadWindow {
  const offsets = [0];
  for (let index = 0; index < content.length; index++) if (content[index] === "\n") offsets.push(index + 1);
  const totalLines = offsets.length;
  let startLine = lineInteger(params.start_line, 1);
  let endLine = lineInteger(params.end_line, totalLines);
  if (params.locator !== undefined) {
    const locator = readRequiredString(params.locator, "locator");
    const offset = content.indexOf(locator);
    if (offset < 0) fail("ea_locator_not_found", "The exact locator was not found.");
    const around = lineInteger(params.context_lines, 12);
    startLine = Math.max(1, lineAt(content, offset) - around);
    endLine = Math.min(totalLines, lineAt(content, offset + locator.length) + around);
  }
  if (startLine > totalLines || endLine < startLine)
    fail("ea_read_range_invalid", "The requested line range is outside this file.");
  endLine = Math.min(totalLines, endLine);
  const start = offsets[startLine - 1]!;
  const requestedEnd = offsets[endLine] ?? content.length;
  const requested = content.slice(start, requestedEnd);
  const bytes = Buffer.from(requested, "utf8");
  const text = bytes.subarray(0, utf8WindowEnd(bytes, Math.min(bytes.length, maxBytes))).toString("utf8");
  const end = start + text.length;
  return { start, end, text, startLine, totalLines, truncated: text.length !== requested.length,
    complete: start === 0 && end === content.length };
}

function lineInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1_000_000)
    fail("ea_read_range_invalid", "Expected a positive integer line bound.");
  return Number(value);
}
