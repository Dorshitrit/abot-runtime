import { lstat, readdir, realpath, symlink } from "node:fs/promises";
import { basename, join, posix, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { LIMITS, requireValue } from "./contracts.js";
import { createManagedFile, createPrivateManagedDirectory } from "./host-files.js";
import { parseLlamaZip } from "./zip-archive.js";

const BLOCK = 512;
const PATH_BYTES = 4096;
const decoder = new TextDecoder("utf-8", { fatal: true });
export type ArchiveEntry = { path: string; kind: "file" | "directory" | "symlink"; mode: number; data: Buffer; target?: string };
export interface ExtractionCounts {
  parsedRecords: number;
  files: number;
  directories: number;
  symlinks: number;
  expandedBytes: number;
  fileBytes: number;
}
export interface ExtractionResult extends ExtractionCounts {
  executable: string;
  coverage: "complete archive";
  unresolvedParsingExceptions: string[];
}

function check(condition: unknown, message: string): asserts condition {
  requireValue(condition, "invalid_archive", message);
}

/** Bounds both compressed input and the complete uncompressed tar, including padding. */
async function inflate(source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let compressed = 0;
  let expanded = 0;
  async function* boundedInput() {
    for await (const chunk of source) {
      signal.throwIfAborted();
      compressed += chunk.byteLength;
      check(compressed <= LIMITS.expandedBytes, "Compressed archive exceeds byte limit.");
      yield chunk;
    }
  }
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      try {
        expanded += chunk.length;
        check(expanded <= LIMITS.expandedBytes, "Expanded archive exceeds byte limit.");
        chunks.push(Buffer.from(chunk));
        done();
      } catch (error) { done(error as Error); }
    },
  });
  // Gunzip validates gzip CRC and length; pipeline propagates corruption and aborts.
  await pipeline(Readable.from(boundedInput()), createGunzip(), sink, { signal });
  signal.throwIfAborted();
  return Buffer.concat(chunks, expanded);
}

function text(field: Buffer): string {
  const end = field.indexOf(0);
  if (end < 0) return decoder.decode(field);
  check(field.subarray(end).every(byte => byte === 0), "Nonzero data after string terminator.");
  return decoder.decode(field.subarray(0, end));
}

function octal(field: Buffer, label: string): number {
  check(field.every(byte => byte === 0 || byte === 32 || (byte >= 48 && byte <= 55)), "Unsupported numeric encoding: " + label);
  const value = field.toString("ascii").replace(/\0/g, " ").trim();
  check(/^[0-7]+$/u.test(value), "Missing or invalid numeric field: " + label);
  const number = Number.parseInt(value, 8);
  check(Number.isSafeInteger(number) && number >= 0, "Numeric overflow: " + label);
  return number;
}

function safePath(raw: string): string {
  check(raw.length > 0 && Buffer.byteLength(raw) <= PATH_BYTES, "Invalid path length.");
  check(!/[\p{Cc}\p{Cf}\\:]/u.test(raw) && !raw.startsWith("/"), "Unsafe archive path.");
  const parts = raw.split("/");
  check(!parts.includes(".."), "Path traversal is forbidden.");
  const normalized = parts.filter(part => part && part !== ".").join("/");
  check(normalized.length > 0 && normalized === normalized.normalize("NFC"), "Empty or noncanonical path.");
  check(normalized.split("/").every(part => !/[. ]$/u.test(part)), "Ambiguous path component.");
  return normalized;
}

function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"));
}

function validateHeader(header: Buffer): boolean {
  const expected = octal(header.subarray(148, 156), "checksum");
  let checksum = 0;
  for (let i = 0; i < BLOCK; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
  check(checksum === expected, "Tar header checksum mismatch.");
  const gnu = header.subarray(257, 265).equals(Buffer.from("ustar  \0"));
  const posix = header.subarray(257, 265).equals(Buffer.from("ustar\0" + "00"));
  check(gnu || posix, "Only POSIX ustar or basic GNU tar is supported.");
  // GNU uses this area for sparse/extended fields, not a POSIX name prefix.
  check(header.subarray(gnu ? 345 : 500).every(byte => byte === 0), "Unsupported tar header extension.");
  return gnu;
}

function parseTar(tar: Buffer, signal: AbortSignal, counts: ExtractionCounts): ArchiveEntry[] {
  check(tar.length >= BLOCK * 2 && tar.length % BLOCK === 0, "Incomplete tar blocks.");
  const entries: ArchiveEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  let terminated = false;
  while (offset < tar.length) {
    signal.throwIfAborted();
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every(byte => byte === 0)) {
      check(offset + BLOCK * 2 <= tar.length && tar.subarray(offset).every(byte => byte === 0), "Invalid tar terminator or trailing data.");
      terminated = true;
      break;
    }
    const gnu = validateHeader(header);
    // PAX (x/g), GNU long names, sparse files, devices and hardlinks fail closed.
    // No metadata is silently skipped or applied to a different entry.
    const type = header[156];
    check(type === 0 || type === 48 || type === 53 || type === 50, "Unsupported tar entry type (including PAX/GNU extensions).");
    const size = octal(header.subarray(124, 136), "size");
    const mode = octal(header.subarray(100, 108), "mode");
    check(size <= LIMITS.expandedBytes && mode <= 0o7777, "Invalid size or mode.");
    const name = text(header.subarray(0, 100));
    const prefix = gnu ? "" : text(header.subarray(345, 500));
    const path = safePath(prefix ? prefix + "/" + name : name);
    check(!names.has(path), "Duplicate archive entry: " + path);
    names.add(path);
    const kind = type === 53 ? "directory" : type === 50 ? "symlink" : "file";
    check(kind === "file" || size === 0, "Non-file entry carries data.");
    const start = offset + BLOCK;
    const next = start + Math.ceil(size / BLOCK) * BLOCK;
    check(next <= tar.length, "Truncated tar entry.");
    check(tar.subarray(start + size, next).every(byte => byte === 0), "Nonzero tar entry padding.");
    const link = text(header.subarray(157, 257));
    check(kind === "symlink" || link === "", "Unexpected link metadata.");
    const entry: ArchiveEntry = { path, kind, mode, data: tar.subarray(start, start + size) };
    if (kind === "symlink") {
      check(link.length > 0 && Buffer.byteLength(link) <= PATH_BYTES && !/[\p{Cc}\p{Cf}\\:]/u.test(link) && !posix.isAbsolute(link), "Unsafe symlink target.");
      entry.target = safePath(posix.normalize(posix.join(posix.dirname(path), link)));
    }
    entries.push(entry);
    counts.parsedRecords++;
    check(counts.parsedRecords <= LIMITS.files, "Archive entry count exceeds limit.");
    if (kind === "file") { counts.files++; counts.fileBytes += size; }
    else if (kind === "directory") counts.directories++;
    else counts.symlinks++;
    offset = next;
  }
  check(terminated, "Missing tar end marker.");
  return entries;
}

/** Validate the entire namespace and link graph before creating any extracted path. */
function validateEntries(entries: ArchiveEntry[], executableName: string): { executable: string; directories: string[] } {
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  const directoryPaths = new Set<string>();
  const canonicalNames = new Map<string, string>();
  function register(path: string) {
    const key = path.normalize("NFC").toLowerCase();
    const previous = canonicalNames.get(key);
    check(previous === undefined || previous === path, "Case-insensitive archive path collision.");
    canonicalNames.set(key, path);
    check(canonicalNames.size <= LIMITS.files, "Archive namespace exceeds entry limit.");
  }
  for (const entry of entries) {
    register(entry.path);
    if (entry.kind === "directory") directoryPaths.add(entry.path);
    for (const parent of ancestors(entry.path)) {
      register(parent);
      check(!byPath.has(parent) || byPath.get(parent)!.kind === "directory", "File or symlink used as an ancestor.");
      directoryPaths.add(parent);
    }
  }
  for (const entry of entries) {
    if (entry.kind !== "symlink") continue;
    const visited = new Set<string>([entry.path]);
    let target = entry.target!;
    for (;;) {
      check(!visited.has(target), "Symlink cycle.");
      visited.add(target);
      check(ancestors(target).every(parent => !byPath.has(parent) || byPath.get(parent)!.kind === "directory"), "Symlink target has a non-directory ancestor.");
      const destination = byPath.get(target);
      check(destination !== undefined && destination.kind !== "directory", "Symlinks must resolve to an internal regular file.");
      if (destination.kind === "file") break;
      target = destination.target!;
    }
  }
  const servers = entries.filter(entry => basename(entry.path) === executableName);
  check(servers.length === 1 && servers[0]!.kind === "file" && (servers[0]!.mode & 0o111) !== 0 && servers[0]!.data.length > 0, "Expected exactly one regular executable llama-server.");
  return {
    executable: servers[0]!.path,
    directories: [...directoryPaths].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)),
  };
}

/** Caller must exclusively own staging and its ancestors for this operation's duration.
 * Staging must already exist, be empty, and have a canonical non-symlink path.
 * Failure leaves partial files in staging for caller-owned cleanup; nothing is deleted.
 * PAX and GNU extensions explicitly fail closed. No ownership or special modes restored.
 */
export async function extractArchive(
  source: AsyncIterable<Uint8Array>, stagingDirectory: string, signal: AbortSignal, format: "tar.gz" | "zip" = "tar.gz",
): Promise<ExtractionResult> {
  const counts: ExtractionCounts = { parsedRecords: 0, files: 0, directories: 0, symlinks: 0, expandedBytes: 0, fileBytes: 0 };
  let phase = "staging";
  try {
    signal.throwIfAborted();
    const root = resolve(stagingDirectory);
    const stat = await lstat(root);
    check(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(root) === root, "Staging must be a canonical real directory.");
    check((await readdir(root)).length === 0, "Staging must be empty.");
    phase = "archive validation";
    let entries: ArchiveEntry[];
    if (format === "zip") {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of source) {
        signal.throwIfAborted();
        length += chunk.byteLength;
        check(length <= LIMITS.expandedBytes, "ZIP exceeds byte limit.");
        chunks.push(Buffer.from(chunk));
      }
      entries = await parseLlamaZip(Buffer.concat(chunks, length), signal, counts);
    } else {
      const tar = await inflate(source, signal);
      counts.expandedBytes = tar.length;
      entries = parseTar(tar, signal, counts);
    }
    const plan = validateEntries(entries, format === "zip" ? "llama-server.exe" : "llama-server");
    phase = "extraction";
    signal.throwIfAborted();
    check((await readdir(root)).length === 0, "Staging changed before extraction.");
    for (const directory of plan.directories) {
      signal.throwIfAborted();
      await createPrivateManagedDirectory(join(root, directory));
    }
    // Write regular files before links, with exclusive no-follow opens.
    for (const entry of entries) {
      signal.throwIfAborted();
      if (entry.kind !== "file") continue;
      const file = await createManagedFile(join(root, entry.path));
      try {
        await file.writeFile(entry.data, { signal });
        if (process.platform !== "win32") await file.chmod(entry.mode & 0o111 ? 0o700 : 0o600);
      } finally { await file.close(); }
    }
    for (const entry of entries) {
      signal.throwIfAborted();
      if (entry.kind === "symlink") {
        const relativeTarget = posix.relative(posix.dirname(entry.path), entry.target!);
        await symlink(relativeTarget, join(root, entry.path));
      }
    }
    signal.throwIfAborted();
    return { ...counts, executable: plan.executable, coverage: "complete archive", unresolvedParsingExceptions: [] };
  } catch (cause) {
    const error = new Error("Archive extraction failed during " + phase + ".", { cause });
    Object.assign(error, {
      extraction: { ...counts, phase, coverage: "incomplete; extraction failed", unresolvedParsingExceptions: [cause instanceof Error ? cause.message : String(cause)] },
    });
    throw error;
  }
}
