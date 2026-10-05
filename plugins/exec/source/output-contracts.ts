import type { Writable } from "node:stream";

export const DEFAULT_EXEC_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Resource bound for one disk operation, independent of model context budgets. */
export const EXEC_OUTPUT_IO_CHUNK_BYTES = 64 * 1024;

export type ExecOutputStream = "stdout" | "stderr";
export type ExecOutputBody = Readonly<{
  id: string;
  stream: ExecOutputStream;
  startByte: number;
  endByte: number;
  byteLength: number;
  sha256: string;
}>;
export type ExecOutputRange = Readonly<{
  offset: number;
  length: number;
  maxChunkBytes: number;
  signal?: AbortSignal;
}>;
export type ExecOutputWriter = Readonly<{
  sink: Writable;
  /** Bytes whose write callbacks completed; pending pipe buffers are excluded. */
  byteLength: number;
  /** Committed prefix that does not end inside an incomplete UTF8 code point. */
  utf8ByteLength: number;
  completion: Promise<void>;
  snapshot(
    range?: Readonly<{ startByte: number; endByte?: number }>,
  ): Promise<ExecOutputBody>;
  /** Closes the handle only; retained output remains readable. */
  dispose(): Promise<void>;
}>;
export type ExecOutputSnapshotRecord = Readonly<{
  kind: "exec_output_snapshot_v1";
  ownerId: string;
  streamId: string;
  body: ExecOutputBody;
}>;
export type ExecOutputOwnerRecord = Readonly<{
  kind: "exec_output_owner_v1";
  ownerId: string;
  completedAt: number | null;
}>;
