import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import type { ResolvedRuntimeToolPath } from "./tool-types.js";

export type ToolFileOutputLocation = "agent_work" | "workspace";
export type ToolFileOutputOperation = "created" | "updated";

/** Client presentation only; this receipt never belongs to a tool result. */
export type ToolFileOutputReceipt = Readonly<{
  version: 1;
  location: ToolFileOutputLocation;
  rootId: string;
  relativePath: string;
  logicalPath: string;
  operation: ToolFileOutputOperation;
}>;

export type ToolFileOutputReport = Readonly<{
  target: ResolvedRuntimeToolPath;
  operation: ToolFileOutputOperation;
  rootIdentity?: ToolFileOutputRootIdentity;
}>;

/** Captured from the actual mutation root while its directory handle is held. */
export type ToolFileOutputRootIdentity = Readonly<{
  device: string;
  inode: string;
  birthtimeNs: string;
}>;

/** Reports a committed file mutation to the host, outside model-visible data. */
export type ToolFileOutputReporter = (report: ToolFileOutputReport) => void;

type ToolFileOutputRootStats = Pick<
  BigIntStats,
  "dev" | "ino" | "birthtimeNs" | "isDirectory"
>;

export function hasStableFileOutputRootIdentity(
  identity: ToolFileOutputRootStats,
): boolean {
  if (!identity.isDirectory()) return false;
  if (typeof identity.dev !== "bigint") return false;
  if (identity.dev < 0n) return false;
  if (typeof identity.ino !== "bigint") return false;
  if (identity.ino <= 0n) return false;
  if (typeof identity.birthtimeNs !== "bigint") return false;
  return identity.birthtimeNs > 0n;
}

/**
 * The caller supplies the canonical rootPath returned by the host resolver.
 * Encoding: SHA-256 of UTF-8 JSON [v3 domain, location, canonical root, decimal
 * device, inode, birthtimeNs, root marker token], with a sha256: prefix. The
 * random marker distinguishes roots even if an inode and birth time are reused.
 * Child changes must not invalidate the root, so mtime/ctime are never included.
 * Older path-only hashes cannot match; unavailable birth identity fails closed.
 */
export function createFileOutputRootId(
  location: ToolFileOutputLocation,
  canonicalRoot: string,
  identity: ToolFileOutputRootStats,
  markerToken: string,
): string {
  if (!hasStableFileOutputRootIdentity(identity))
    throw new Error("Stable file-output root identity is unavailable.");
  if (!/^[a-f0-9]{64}$/u.test(markerToken))
    throw new Error("Stable file-output root marker is unavailable.");
  const encoded = JSON.stringify([
    "abot-file-output-root-v3",
    location,
    canonicalRoot,
    identity.dev.toString(),
    identity.ino.toString(),
    identity.birthtimeNs.toString(),
    markerToken,
  ]);
  return `sha256:${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}

export function isToolFileOutputLocation(
  value: unknown,
): value is ToolFileOutputLocation {
  return value === "agent_work" || value === "workspace";
}

function isFileOutputRecord(value: unknown): value is Record<string, unknown> {
  if (value === null) return false;
  if (typeof value !== "object") return false;
  return !Array.isArray(value);
}

function isRootIdentityInteger(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^(?:0|[1-9][0-9]{0,63})$/u.test(value);
}

/** A detached host report binding; filesystem authority is verified separately. */
export function parseToolFileOutputRootIdentity(
  value: unknown,
): ToolFileOutputRootIdentity | undefined {
  if (!isFileOutputRecord(value)) return undefined;
  if (!isRootIdentityInteger(value.device)) return undefined;
  if (!isRootIdentityInteger(value.inode)) return undefined;
  if (value.inode === "0") return undefined;
  if (!isRootIdentityInteger(value.birthtimeNs)) return undefined;
  if (value.birthtimeNs === "0") return undefined;
  return Object.freeze({
    device: value.device,
    inode: value.inode,
    birthtimeNs: value.birthtimeNs,
  });
}

function isFileOutputRelativePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (value.length > 4096) return false;
  if (value.includes("\0")) return false;
  if (value.includes("\\")) return false;
  if (/^[A-Za-z]:/u.test(value)) return false;
  return value.split("/").every(isFileOutputPathSegment);
}

function isFileOutputPathSegment(value: string): boolean {
  if (value.length === 0) return false;
  if (value === ".") return false;
  return value !== "..";
}

function isFileOutputOperation(
  value: unknown,
): value is ToolFileOutputOperation {
  return value === "created" || value === "updated";
}

function isFileOutputRootId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^sha256:[a-f0-9]{64}$/u.test(value);
}

/** Structural validation is not authorization; the server must verify origin. */
export function parseToolFileOutputReceipt(
  value: unknown,
): ToolFileOutputReceipt | undefined {
  if (!isFileOutputRecord(value)) return undefined;
  if (value.version !== 1) return undefined;
  if (!isToolFileOutputLocation(value.location)) return undefined;
  if (!isFileOutputRelativePath(value.relativePath)) return undefined;
  if (!isFileOutputOperation(value.operation)) return undefined;
  if (!isFileOutputRootId(value.rootId)) return undefined;
  const logicalPath =
    value.location === "workspace"
      ? `workspace/${value.relativePath}`
      : value.relativePath;
  if (value.logicalPath !== logicalPath) return undefined;
  return Object.freeze({
    version: 1,
    location: value.location,
    rootId: value.rootId,
    relativePath: value.relativePath,
    logicalPath,
    operation: value.operation,
  });
}
