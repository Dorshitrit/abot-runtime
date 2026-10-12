import type { BigIntStats } from "node:fs";
import { fail } from "./errors.js";

export type MutationFileMetadata = Readonly<{
  device: bigint;
  inode: bigint;
  size: number;
  mode: number;
  modifiedNs: bigint;
  changedNs: bigint;
}>;

export function metadataFromStat(
  info: BigIntStats,
  logicalPath: string,
): MutationFileMetadata {
  if (info.size > BigInt(Number.MAX_SAFE_INTEGER))
    fail("file_too_large", `File is too large to read safely: ${logicalPath}`);
  return Object.freeze({
    device: info.dev,
    inode: info.ino,
    size: Number(info.size),
    mode: Number(info.mode) & 0o7777,
    modifiedNs: info.mtimeNs,
    changedNs: info.ctimeNs,
  });
}

export function sameMetadata(
  left: MutationFileMetadata,
  right: MutationFileMetadata,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.modifiedNs === right.modifiedNs &&
    left.changedNs === right.changedNs
  );
}
