import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";
import type { ResolvedRuntimeToolPath } from "../../../src/plugin-sdk/index.js";
import { fail, FilesystemToolError, rethrowFilesystemError } from "./errors.js";
import { observeFileSlices } from "./file-observation.js";
import { sameMetadata, type MutationFileMetadata } from "./file-version.js";

export { readExactBytes } from "./file-observation.js";
export {
  readDirectorySample,
  DIRECTORY_ENTRY_LIMIT,
} from "./directory-sample.js";
export const MAX_MUTATION_BYTES = 1_048_576;
export const READ_HEAD_BYTES = 24_576;
export const READ_TAIL_BYTES = 12_288;
export const DEV_SCAN_BYTES = 1_048_576;

export type BoundedText = Readonly<{
  text: string;
  byteCount: number;
  bytesRead: number;
  omittedBytes: number;
  truncated: boolean;
}>;
export type MutationTargetVersion =
  | Readonly<{ kind: "absent" }>
  | Readonly<MutationFileMetadata & { kind: "file"; digest: string }>;
export type MutationSnapshot = Readonly<{
  content: string | null;
  version: MutationTargetVersion;
}>;

function decodeCompletePrefix(buffer: Buffer): string {
  return new StringDecoder("utf8").write(buffer);
}
function decodeSuffix(buffer: Buffer): string {
  let start = 0;
  while (start < Math.min(4, buffer.length) && (buffer[start]! & 0xc0) === 0x80)
    start += 1;
  return buffer.subarray(start).toString("utf8");
}
function decodeMutationText(buffer: Buffer, logicalPath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail(
      "filesystem_invalid_encoding",
      `File is not valid UTF-8 text: ${logicalPath}`,
    );
  }
}

export async function readBoundedText(
  target: ResolvedRuntimeToolPath,
  options: Readonly<{ headBytes?: number; tailBytes?: number }> = {},
): Promise<BoundedText> {
  const observed = await observeFileSlices(target, {
    headBytes: options.headBytes ?? READ_HEAD_BYTES,
    tailBytes: options.tailBytes ?? READ_TAIL_BYTES,
  });
  rejectBinary(observed.head, target.logicalPath);
  rejectBinary(observed.tail, target.logicalPath);
  const bytesRead = observed.head.length + observed.tail.length;
  const omittedBytes = observed.metadata.size - bytesRead;
  const text =
    omittedBytes === 0
      ? decodeCompletePrefix(observed.head)
      : [
          decodeCompletePrefix(observed.head),
          `[${omittedBytes} bytes omitted from the middle]`,
          decodeSuffix(observed.tail),
        ].join("\n");
  return Object.freeze({
    text,
    byteCount: observed.metadata.size,
    bytesRead,
    omittedBytes,
    truncated: omittedBytes > 0,
  });
}

export async function readPrefixText(
  target: ResolvedRuntimeToolPath,
  maxBytes: number = DEV_SCAN_BYTES,
): Promise<BoundedText> {
  const observed = await observeFileSlices(target, {
    headBytes: maxBytes,
    tailBytes: 0,
  });
  rejectBinary(observed.head, target.logicalPath);
  return Object.freeze({
    text: decodeCompletePrefix(observed.head),
    byteCount: observed.metadata.size,
    bytesRead: observed.head.length,
    omittedBytes: observed.metadata.size - observed.head.length,
    truncated: observed.head.length < observed.metadata.size,
  });
}

export async function readMutationSnapshot(
  target: ResolvedRuntimeToolPath,
): Promise<MutationSnapshot> {
  try {
    const observed = await observeFileSlices(target, {
      headBytes: MAX_MUTATION_BYTES,
      tailBytes: 0,
      maximumFileBytes: MAX_MUTATION_BYTES,
    });
    rejectBinary(observed.head, target.logicalPath);
    return Object.freeze({
      content: decodeMutationText(observed.head, target.logicalPath),
      version: Object.freeze({
        kind: "file",
        ...observed.metadata,
        digest: digest(observed.head),
      }),
    });
  } catch (error) {
    if (error instanceof FilesystemToolError && error.code === "file_not_found")
      return Object.freeze({
        content: null,
        version: Object.freeze({ kind: "absent" }),
      });
    if (
      error instanceof FilesystemToolError &&
      error.code === "filesystem_read_changed"
    )
      failTargetChanged(target.logicalPath, "file", "file");
    return rethrowFilesystemError(error, "read", target.logicalPath);
  }
}

export async function assertMutationTargetUnchanged(
  target: ResolvedRuntimeToolPath,
  expected: MutationTargetVersion,
): Promise<void> {
  let current: MutationSnapshot;
  try {
    current = await readMutationSnapshot(target);
  } catch (error) {
    const changedContents =
      error instanceof FilesystemToolError &&
      [
        "file_too_large",
        "binary_file_unsupported",
        "filesystem_invalid_encoding",
      ].includes(error.code);
    if (changedContents)
      failTargetChanged(target.logicalPath, expected.kind, "file");
    throw error;
  }
  if (current.version.kind !== expected.kind)
    failTargetChanged(target.logicalPath, expected.kind, current.version.kind);
  if (current.version.kind === "absent" || expected.kind === "absent") return;
  if (
    !sameMetadata(expected, current.version) ||
    expected.digest !== current.version.digest
  )
    failTargetChanged(target.logicalPath, "file", "file");
}

export function assertMutationContentSize(content: string): number {
  const byteCount = Buffer.byteLength(content, "utf8");
  if (byteCount > MAX_MUTATION_BYTES) {
    fail(
      "file_too_large",
      `Prepared content exceeds the ${MAX_MUTATION_BYTES}-byte mutation limit.`,
      { byteCount, maxBytes: MAX_MUTATION_BYTES },
    );
  }
  return byteCount;
}
function rejectBinary(buffer: Buffer, logicalPath: string): void {
  if (buffer.includes(0))
    fail(
      "binary_file_unsupported",
      `Binary file is not supported: ${logicalPath}`,
    );
}
function digest(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
function failTargetChanged(
  logicalPath: string,
  expectedState: MutationTargetVersion["kind"],
  observedState: MutationTargetVersion["kind"],
): never {
  fail(
    "filesystem_target_changed",
    `Target changed while the mutation was being prepared; no file was written: ${logicalPath}`,
    { path: logicalPath, expectedState, observedState },
  );
}
