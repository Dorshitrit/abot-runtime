import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { InformationBasketError } from "./contracts.js";

/** Shared with indexing and selected reads; never extracts or hashes document bytes. */
export function basketFileIdentity(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

export async function readBasketFileIdentity(path: string): Promise<string> {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile()) throw new InformationBasketError("basket_source_unavailable");
  return basketFileIdentity(info);
}
