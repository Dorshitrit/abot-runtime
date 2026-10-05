import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { ExecPluginError } from "./errors.js";
import {
  EXEC_OUTPUT_IO_CHUNK_BYTES,
  type ExecOutputBody,
  type ExecOutputRange,
} from "./output-contracts.js";
import { outputFailure } from "./output-files.js";

export function assertOutputRange(
  startByte: number,
  endByte: number,
  availableBytes: number,
): void {
  if (!Number.isSafeInteger(startByte) || startByte < 0)
    throw outputFailure("range_invalid");
  if (!Number.isSafeInteger(endByte) || endByte < startByte)
    throw outputFailure("range_invalid");
  if (endByte > availableBytes) throw outputFailure("range_invalid");
}
export async function* readOutputFileRange(
  path: string,
  range: ExecOutputRange,
): AsyncIterable<Uint8Array> {
  assertOutputRange(
    range.offset,
    range.offset + range.length,
    Number.MAX_SAFE_INTEGER,
  );
  if (
    !Number.isSafeInteger(range.maxChunkBytes) ||
    range.maxChunkBytes < 1 ||
    range.maxChunkBytes > EXEC_OUTPUT_IO_CHUNK_BYTES
  )
    throw outputFailure("chunk_size_invalid");
  range.signal?.throwIfAborted();
  const handle = await open(path, "r").catch((error) => {
    throw outputFailure("read_failed", error);
  });
  try {
    const end = range.offset + range.length;
    let position = range.offset;
    while (position < end) {
      range.signal?.throwIfAborted();
      const buffer = Buffer.allocUnsafe(
        Math.min(range.maxChunkBytes, end - position),
      );
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) throw outputFailure("body_incomplete");
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
    range.signal?.throwIfAborted();
  } catch (error) {
    if (range.signal?.aborted) throw error;
    if (error instanceof ExecPluginError) throw error;
    throw outputFailure("read_failed", error);
  } finally {
    await handle.close();
  }
}
export async function hashOutputRange(
  path: string,
  startByte: number,
  endByte: number,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of readOutputFileRange(path, {
    offset: startByte,
    length: endByte - startByte,
    maxChunkBytes: EXEC_OUTPUT_IO_CHUNK_BYTES,
    ...(signal ? { signal } : {}),
  }))
    hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}
export async function assertOutputBodyHash(
  path: string,
  body: ExecOutputBody,
  signal?: AbortSignal,
): Promise<void> {
  assertOutputRange(body.startByte, body.endByte, Number.MAX_SAFE_INTEGER);
  if (body.byteLength !== body.endByte - body.startByte)
    throw outputFailure("snapshot_binding_invalid");
  if (
    (await hashOutputRange(path, body.startByte, body.endByte, signal)) !==
    body.sha256
  )
    throw outputFailure("body_hash_mismatch");
}
