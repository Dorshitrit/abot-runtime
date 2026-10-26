import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute } from "node:path";
import { readBoundedRegularFile } from "../../plugin-sdk/files.js";
import { InformationBasketError } from "./contracts.js";
import type { BasketSourceDocument } from "./index-records.js";
import { BASKET_LIMITS, BASKET_SUPPORTED_EXTENSIONS } from "./limits.js";
import { extractBasketPdfText } from "./pdf-source-reader.js";
import { basketFileIdentity } from "./source-identity.js";

export function isBasketSupportedPath(path: string): boolean {
  return (BASKET_SUPPORTED_EXTENSIONS as readonly string[]).includes(extname(path).toLowerCase());
}

function isAbsoluteBasketPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (!path || path.length > 4_096 || path.includes("\0")) return false;
  return isAbsolute(path);
}

export function basketIoFailure(error: unknown): InformationBasketError {
  if (error instanceof InformationBasketError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return new InformationBasketError("basket_source_not_found", undefined, 404);
  if (code === "EACCES" || code === "EPERM")
    return new InformationBasketError("basket_source_unreadable", undefined, 403);
  return new InformationBasketError("basket_source_unavailable", undefined, 503);
}

export async function resolveBasketSourcePath(path: string) {
  if (!isAbsoluteBasketPath(path))
    throw new InformationBasketError("basket_source_absolute_path_required");
  try {
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (!info.isFile()) throw new InformationBasketError("basket_source_regular_file_required");
    if (!isBasketSupportedPath(canonical))
      throw new InformationBasketError("basket_source_format_unsupported");
    if (info.size > BASKET_LIMITS.maxSourceBytes)
      throw new InformationBasketError("basket_source_too_large");
    return Object.freeze({ path: canonical, displayName: basename(canonical), sizeBytes: info.size });
  } catch (error) { throw basketIoFailure(error); }
}

function decodeBasketText(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new InformationBasketError("basket_source_binary_text");
    return text;
  } catch (error) {
    if (error instanceof InformationBasketError) throw error;
    throw new InformationBasketError("basket_source_encoding_unsupported");
  }
}

/** A reader seam: transient bytes only, with exact content hashes for later reads. */
export async function readBasketSourceDocument(path: string, signal?: AbortSignal): Promise<BasketSourceDocument> {
  signal?.throwIfAborted();
  if (!isBasketSupportedPath(path)) throw new InformationBasketError("basket_source_format_unsupported");
  try {
    const before = await stat(path, { bigint: true });
    const file = await readBoundedRegularFile(path, {
      rootPath: dirname(path), maxBytes: BASKET_LIMITS.maxSourceBytes, signal,
    });
    if (!file.ok) throw new InformationBasketError("basket_source_" + file.reason);
    const text = extname(path).toLowerCase() === ".pdf"
      ? await extractBasketPdfText(file.bytes, signal)
      : decodeBasketText(file.bytes);
    signal?.throwIfAborted();
    const after = await stat(path, { bigint: true });
    const fileIdentity = basketFileIdentity(before);
    const afterIdentity = basketFileIdentity(after);
    if (fileIdentity !== afterIdentity)
      throw new InformationBasketError("basket_source_changed_during_read", undefined, 409);
    if (text.length > BASKET_LIMITS.maxTextCharacters)
      throw new InformationBasketError("basket_source_text_too_large");
    if (!text.trim()) throw new InformationBasketError("basket_source_no_extractable_text");
    return Object.freeze({
      text, fileIdentity, sizeBytes: file.byteCount,
      contentHash: createHash("sha256").update(file.bytes).digest("hex"),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw basketIoFailure(error);
  }
}
