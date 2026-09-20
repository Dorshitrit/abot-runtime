import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import { join } from "node:path";
import {
  createFileOutputRootId,
  hasStableFileOutputRootIdentity,
  parseToolFileOutputRootIdentity,
  type ToolFileOutputLocation,
  type ToolFileOutputRootIdentity,
} from "../../capabilities/file-output-presentation.js";
import { initializeFileOutputRootMarker } from "./file-output-root-marker-creation.js";

const markerName = ".abot-file-output-root";
const markerPrefix = "abot-file-output-root-v1\n";
const markerSize = Buffer.byteLength(markerPrefix) + 64 + 1;

function rootIdentityUnavailable(): never {
  throw new Error("Stable file-output root identity is unavailable.");
}

function sameRootInstance(left: BigIntStats, right: BigIntStats): boolean {
  if (left.dev !== right.dev) return false;
  if (left.ino !== right.ino) return false;
  return left.birthtimeNs === right.birthtimeNs;
}

function matchesCommittedRootIdentity(
  opened: BigIntStats,
  expected: ToolFileOutputRootIdentity | undefined,
): boolean {
  if (expected === undefined) return true;
  const identity = parseToolFileOutputRootIdentity(expected);
  if (!identity) return false;
  if (opened.dev.toString() !== identity.device) return false;
  if (opened.ino.toString() !== identity.inode) return false;
  return opened.birthtimeNs.toString() === identity.birthtimeNs;
}

function sameMarkerVersion(left: BigIntStats, right: BigIntStats): boolean {
  if (!sameRootInstance(left, right)) return false;
  if (left.size !== right.size) return false;
  if (left.mtimeNs !== right.mtimeNs) return false;
  return left.ctimeNs === right.ctimeNs;
}

function canonicalRootIdentity(canonicalRoot: string): BigIntStats {
  if (realpathSync(canonicalRoot) !== canonicalRoot) rootIdentityUnavailable();
  const identity = statSync(canonicalRoot, { bigint: true });
  if (!identity.isDirectory()) rootIdentityUnavailable();
  return identity;
}

function canReadRootMarker(identity: BigIntStats): boolean {
  if (!identity.isFile()) return false;
  if (identity.nlink !== 1n) return false;
  return identity.size === BigInt(markerSize);
}

function parseRootMarker(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  if (!text.startsWith(markerPrefix)) rootIdentityUnavailable();
  const token = text.slice(markerPrefix.length, -1);
  if (!/^[a-f0-9]{64}$/u.test(token)) rootIdentityUnavailable();
  if (!text.endsWith("\n")) rootIdentityUnavailable();
  return token;
}

function requireSafeRootMarkerOpen(): void {
  if (typeof constants.O_NOFOLLOW !== "number") rootIdentityUnavailable();
  if (typeof constants.O_NONBLOCK !== "number") rootIdentityUnavailable();
  if (typeof constants.O_DIRECTORY !== "number") rootIdentityUnavailable();
}

function readRootMarker(markerPath: string): string {
  requireSafeRootMarkerOpen();
  const handle = openSync(
    markerPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(handle, { bigint: true });
    if (!canReadRootMarker(before)) rootIdentityUnavailable();
    const bytes = Buffer.alloc(markerSize + 1);
    const length = readSync(handle, bytes, 0, bytes.length, 0);
    if (length !== markerSize) rootIdentityUnavailable();
    const after = fstatSync(handle, { bigint: true });
    if (!sameMarkerVersion(before, after)) rootIdentityUnavailable();
    const current = lstatSync(markerPath, { bigint: true });
    if (!canReadRootMarker(current)) rootIdentityUnavailable();
    if (!sameMarkerVersion(after, current)) rootIdentityUnavailable();
    return parseRootMarker(bytes.subarray(0, length));
  } finally {
    closeSync(handle);
  }
}

function hasFilesystemErrorCode(error: unknown, code: string): boolean {
  if (!(error instanceof Error)) return false;
  return (error as NodeJS.ErrnoException).code === code;
}

function captureRootMarker(
  markerPath: string,
  canonicalRoot: string,
  rootHandle: number,
): string {
  try {
    return readRootMarker(markerPath);
  } catch (error) {
    if (!hasFilesystemErrorCode(error, "ENOENT")) throw error;
  }
  initializeFileOutputRootMarker(canonicalRoot, rootHandle);
  return readRootMarker(markerPath);
}

function rootBoundIdentity(
  location: ToolFileOutputLocation,
  canonicalRoot: string,
  readMarker: (path: string, root: string, handle: number) => string,
  expectedIdentity?: ToolFileOutputRootIdentity,
): string {
  requireSafeRootMarkerOpen();
  const handle = openSync(
    canonicalRoot,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(handle, { bigint: true });
    if (!hasStableFileOutputRootIdentity(before)) rootIdentityUnavailable();
    if (!matchesCommittedRootIdentity(before, expectedIdentity))
      rootIdentityUnavailable();
    const current = canonicalRootIdentity(canonicalRoot);
    if (!sameRootInstance(before, current)) rootIdentityUnavailable();
    const token = readMarker(
      join(canonicalRoot, markerName),
      canonicalRoot,
      handle,
    );
    const after = canonicalRootIdentity(canonicalRoot);
    if (!sameRootInstance(before, after)) rootIdentityUnavailable();
    return createFileOutputRootId(location, canonicalRoot, after, token);
  } finally {
    closeSync(handle);
  }
}

/** Host presentation capture only. Creates a marker once; never overwrites it. */
export function captureFileOutputRootId(
  location: ToolFileOutputLocation,
  canonicalRoot: string,
  expectedIdentity?: ToolFileOutputRootIdentity,
): string {
  return rootBoundIdentity(
    location,
    canonicalRoot,
    captureRootMarker,
    expectedIdentity,
  );
}

/** Preview authorization is read-only: missing or invalid markers stay invalid. */
export function readFileOutputRootId(
  location: ToolFileOutputLocation,
  canonicalRoot: string,
): string {
  return rootBoundIdentity(location, canonicalRoot, readRootMarker);
}
