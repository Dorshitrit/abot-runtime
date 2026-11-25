import { inflateRaw } from "node:zlib";
import { LIMITS, requireValue } from "./contracts.js";
import type { ArchiveEntry, ExtractionCounts } from "./archive.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255]!;
  return (value ^ 0xffffffff) >>> 0;
}
function zipCheck(value: unknown, message: string): asserts value {
  requireValue(value, "invalid_archive", message);
}
function zipPath(bytes: Buffer, utf8: boolean): string {
  zipCheck(utf8 || bytes.every(byte => byte < 128), "ZIP names must be ASCII or explicitly UTF-8.");
  const name = decoder.decode(bytes);
  zipCheck(name.length > 0 && bytes.length <= 4096 && name === name.normalize("NFC"), "Invalid ZIP name.");
  zipCheck(!/[\p{Cc}\p{Cf}\\<>:"|?*]/u.test(name), "Unsafe Windows archive path.");
  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  for (const part of path.split("/")) {
    zipCheck(part.length > 0 && !/[. ]$/u.test(part), "Ambiguous ZIP path.");
    zipCheck(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part), "Reserved Windows device name.");
  }
  return path;
}
/** Only inert timestamp metadata is accepted; ZIP64, alternate names and Unix
 * link metadata are rejected rather than interpreted differently by a library. */
function timestampExtras(bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    zipCheck(offset + 4 <= bytes.length, "Truncated ZIP extra field.");
    const id = bytes.readUInt16LE(offset), size = bytes.readUInt16LE(offset + 2);
    offset += 4;
    zipCheck(offset + size <= bytes.length && (id === 0x000a || id === 0x5455), "Unsupported ZIP metadata.");
    offset += size;
  }
}
function endRecord(bytes: Buffer): number {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) return offset;
  }
  throw new Error("Missing ZIP end record.");
}
type CompressedEntry = { path: string; directory: boolean; size: number; crc: number; method: number; data: Buffer };
function directoryEntries(bytes: Buffer): CompressedEntry[] {
  const end = endRecord(bytes);
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16);
  zipCheck(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0 && bytes.readUInt16LE(end + 8) === count, "Multi-disk ZIP is unsupported.");
  zipCheck(count > 0 && count <= LIMITS.files && start + bytes.readUInt32LE(end + 12) === end, "Invalid ZIP central directory.");
  const entries: CompressedEntry[] = [], names = new Set<string>();
  let offset = start, localEnd = 0, total = 0;
  for (let index = 0; index < count; index++) {
    zipCheck(offset + 46 <= end && bytes.readUInt32LE(offset) === 0x02014b50, "Invalid ZIP directory entry.");
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16), compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const attributes = bytes.readUInt32LE(offset + 38), local = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    zipCheck(next <= end && bytes.readUInt16LE(offset + 34) === 0 && bytes.readUInt16LE(offset + 6) <= 20, "Unsupported ZIP entry version or disk.");
    zipCheck((flags & ~0x800) === 0 && (method === 0 || method === 8), "Encrypted/streaming ZIP or compression method unsupported.");
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const path = zipPath(name, (flags & 0x800) !== 0), directory = name.at(-1) === 47;
    const kind = (attributes >>> 16) & 0o170000;
    zipCheck(kind === 0 || kind === (directory ? 0o040000 : 0o100000), "ZIP special files and links are forbidden.");
    zipCheck((attributes & 0x400) === 0 && ((attributes & 0x10) === 0 || directory), "Invalid ZIP file attributes.");
    zipCheck(!names.has(path.toLowerCase()), "Duplicate ZIP path.");
    names.add(path.toLowerCase());
    timestampExtras(bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength));
    total += size;
    zipCheck(total <= LIMITS.expandedBytes && (!directory || size === 0), "ZIP expansion limit or directory data.");
    zipCheck(local === localEnd && local + 30 <= start && bytes.readUInt32LE(local) === 0x04034b50, "Overlapping, missing or out-of-order ZIP local entry.");
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    localEnd = dataStart + compressed;
    zipCheck(localEnd <= start && localNameLength === nameLength && bytes.subarray(local + 30, local + 30 + nameLength).equals(name), "ZIP name/length mismatch.");
    zipCheck(bytes.readUInt16LE(local + 4) === bytes.readUInt16LE(offset + 6) && bytes.readUInt16LE(local + 6) === flags && bytes.readUInt16LE(local + 8) === method, "ZIP header mismatch.");
    zipCheck(bytes.readUInt32LE(local + 14) === crc && bytes.readUInt32LE(local + 18) === compressed && bytes.readUInt32LE(local + 22) === size, "ZIP data metadata mismatch.");
    timestampExtras(bytes.subarray(local + 30 + nameLength, dataStart));
    entries.push({ path, directory, size, crc, method, data: bytes.subarray(dataStart, localEnd) });
    offset = next;
  }
  zipCheck(offset === end && localEnd === start, "Unaccounted ZIP records or trailing data.");
  return entries;
}
async function inflateEntry(entry: CompressedEntry): Promise<Buffer> {
  if (entry.method === 0) return entry.data;
  return new Promise((resolve, reject) => {
    inflateRaw(entry.data, { maxOutputLength: Math.max(1, entry.size), info: true }, (error, result) => {
      if (error) { reject(error); return; }
      const inflated = result as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      if (inflated.engine.bytesWritten !== entry.data.length) { reject(new Error("Unused ZIP compressed data.")); return; }
      resolve(inflated.buffer);
    });
  });
}
/** Bounded, complete ZIP32 validation before the caller writes any paths. */
export async function parseLlamaZip(bytes: Buffer, signal: AbortSignal, counts: ExtractionCounts): Promise<ArchiveEntry[]> {
  zipCheck(bytes.length <= LIMITS.expandedBytes, "ZIP input exceeds limit.");
  const compressed = directoryEntries(bytes), result: ArchiveEntry[] = [];
  for (const entry of compressed) {
    signal.throwIfAborted();
    const data = await inflateEntry(entry);
    signal.throwIfAborted();
    zipCheck(data.length === entry.size && crc32(data) === entry.crc, "ZIP size/CRC mismatch.");
    result.push({ path: entry.path, kind: entry.directory ? "directory" : "file", mode: entry.path.endsWith(".exe") ? 0o700 : 0o600, data });
    counts.parsedRecords++;
    if (entry.directory) counts.directories++;
    else { counts.files++; counts.fileBytes += data.length; }
    counts.expandedBytes += data.length;
  }
  return result;
}
