import { incompleteUtf8TailBytes } from "./output-utf8-boundary.js";
import { randomUUID } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import {
  EXEC_OUTPUT_IO_CHUNK_BYTES,
  type ExecOutputBody,
  type ExecOutputStream,
  type ExecOutputWriter,
} from "./output-contracts.js";
import {
  outputFailure,
  outputSnapshotPath,
  outputStreamPath,
  writeOutputMetadata,
} from "./output-files.js";
import { assertOutputRange, hashOutputRange } from "./output-range-reader.js";

class OutputFileSink extends Writable {
  committedBytes = 0;
  utf8ByteLength = 0;
  private tail = Buffer.alloc(0);
  constructor(private readonly file: FileHandle) {
    super({ highWaterMark: EXEC_OUTPUT_IO_CHUNK_BYTES });
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writeChunk(chunk).then(
      () => callback(),
      (error) => callback(outputFailure("write_failed", error)),
    );
  }
  private async writeChunk(chunk: Buffer): Promise<void> {
    let offset = 0;
    while (offset < chunk.length) {
      const length = Math.min(
        EXEC_OUTPUT_IO_CHUNK_BYTES,
        chunk.length - offset,
      );
      const { bytesWritten } = await this.file.write(
        chunk,
        offset,
        length,
        this.committedBytes,
      );
      if (bytesWritten === 0) throw outputFailure("write_zero_progress");
      const written = chunk.subarray(offset, offset + bytesWritten);
      this.tail = Buffer.concat([this.tail, written.subarray(-4)]).subarray(-4);
      offset += bytesWritten;
      this.committedBytes += bytesWritten;
      this.utf8ByteLength =
        this.committedBytes - incompleteUtf8TailBytes(this.tail);
    }
  }
  override _final(callback: (error?: Error | null) => void): void {
    this.file.datasync().then(
      () => callback(),
      (error) => callback(outputFailure("write_failed", error)),
    );
  }
  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.file.close().then(
      () => callback(error),
      (cause) => callback(error ?? outputFailure("close_failed", cause)),
    );
  }
}

export async function createOutputWriter(
  params: Readonly<{
    directory: string;
    ownerId: string;
    stream: ExecOutputStream;
    onClosed(): void | Promise<void>;
  }>,
): Promise<ExecOutputWriter> {
  const streamId = randomUUID();
  const path = outputStreamPath(params.directory, streamId);
  const file = await open(path, "wx+", 0o600).catch((error) => {
    throw outputFailure("write_failed", error);
  });
  const sink = new OutputFileSink(file);
  const completion = finished(sink).finally(params.onClosed);
  void completion.catch(() => undefined);
  return Object.freeze({
    sink,
    get byteLength() {
      return sink.committedBytes;
    },
    get utf8ByteLength() {
      return sink.utf8ByteLength;
    },
    completion,
    async snapshot(
      range: Readonly<{ startByte: number; endByte?: number }> = {
        startByte: 0,
      },
    ): Promise<ExecOutputBody> {
      if (sink.errored) throw sink.errored;
      const startByte = range.startByte;
      const endByte = range.endByte ?? sink.committedBytes;
      assertOutputRange(startByte, endByte, sink.committedBytes);
      const body = Object.freeze({
        id: randomUUID(),
        stream: params.stream,
        startByte,
        endByte,
        byteLength: endByte - startByte,
        sha256: await hashOutputRange(path, startByte, endByte),
      });
      await writeOutputMetadata(outputSnapshotPath(params.directory, body.id), {
        kind: "exec_output_snapshot_v1",
        ownerId: params.ownerId,
        streamId,
        body,
      });
      return body;
    },
    async dispose() {
      if (!sink.destroyed) sink.destroy();
      await completion.catch(() => undefined);
    },
  });
}
