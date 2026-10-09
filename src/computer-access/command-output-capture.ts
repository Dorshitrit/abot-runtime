import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { SystemOperationError, type SystemProcessResult } from "./contracts.js";
import type { SystemProcessCapture } from "./process-capture.js";
import { activeSystemCaptures, scheduleSystemOutputCleanup } from "./command-output-retention.js";

const OUTPUT_IO_CHUNK_BYTES = 64 * 1024;
export type SystemOutputReceipt = Readonly<{
  id: string;
  stdoutBytes: number;
  stderrBytes: number;
  completedAt: string;
  retentionMs: number;
  complete: boolean;
  stdoutSha256?: string;
  stderrSha256?: string;
}>;

/** One synchronous command capture; no resumable-process or cursor state. */
export async function createSystemOutputCapture(root: string, retentionMs: number) {
  const id = randomUUID();
  const directory = join(root, id);
  activeSystemCaptures.add(directory);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch {
    activeSystemCaptures.delete(directory);
    throw new SystemOperationError("system_output_storage_failed", "Output storage could not be prepared. The command was not dispatched.");
  }
  let failure: string | undefined;
  let stop: (() => void) | undefined;
  let ended = false;
  let retained = false;
  const sources: Readable[] = [];
  const streams = (["stdout", "stderr"] as const).map((name) => {
    const path = join(directory, name + ".bytes");
    const sink = createWriteStream(path, { flags: "wx", mode: 0o600, highWaterMark: OUTPUT_IO_CHUNK_BYTES, flush: true });
    const completion = finished(sink).catch(() => {
      failure ??= "write_failed";
      stop?.();
    });
    return { name, path, sink, completion, hash: createHash("sha256") };
  });
  try {
    await Promise.all(streams.map(({ sink }) => once(sink, "open")));
  } catch {
    for (const { sink } of streams) sink.destroy();
    await Promise.all(streams.map(({ completion }) => completion));
    activeSystemCaptures.delete(directory);
    scheduleSystemOutputCleanup(root, retentionMs);
    throw new SystemOperationError("system_output_storage_failed", "Output files could not be opened. The command was not dispatched.");
  }
  scheduleSystemOutputCleanup(root, retentionMs);
  const capture: SystemProcessCapture = {
    attach(stdout, stderr, onFailure) {
      stop = onFailure;
      sources.push(stdout, stderr);
      stdout.on("data", (bytes: Buffer) => streams[0]!.hash.update(bytes));
      stderr.on("data", (bytes: Buffer) => streams[1]!.hash.update(bytes));
      stdout.pipe(streams[0]!.sink);
      stderr.pipe(streams[1]!.sink);
      if (failure) onFailure();
    },
    end() {
      if (ended) return;
      ended = true;
      for (const source of sources) { source.unpipe(); source.destroy(); }
      for (const { sink } of streams) if (!sink.destroyed && !sink.writableEnded) sink.end();
    },
  };
  let receipt: SystemOutputReceipt | undefined;
  return {
    capture,
    get receipt() { return receipt; },
    get failure() { return failure; },
    retain() { retained = true; activeSystemCaptures.add(directory); },
    release() { retained = false; activeSystemCaptures.delete(directory); },
    async read(stream: "stdout" | "stderr", offset: number, length: number): Promise<Buffer> {
      const path = streams.find((entry) => entry.name === stream)!.path;
      const file = await open(path, "r");
      try {
        const bytes = Buffer.alloc(length);
        const { bytesRead } = await file.read(bytes, 0, length, offset);
        return bytes.subarray(0, bytesRead);
      } finally { await file.close(); }
    },
    async finish(result?: SystemProcessResult, materialize = true): Promise<{ stdout: string; stderr: string }> {
      capture.end();
      try {
        await Promise.all(streams.map(({ completion }) => completion));
        const sizes = await Promise.all(streams.map(async ({ path }) => {
          try { return (await stat(path)).size; }
          catch { failure ??= "read_failed"; return 0; }
        }));
        let stdout = "", stderr = "";
        if (!failure && materialize) {
          try { [stdout, stderr] = await Promise.all(streams.map(({ path }) => readFile(path, "utf8"))); }
          catch { failure = "read_failed"; }
        }
        const completedAt = Date.now();
        receipt = { id, stdoutBytes: sizes[0]!, stderrBytes: sizes[1]!,
          completedAt: new Date(completedAt).toISOString(), retentionMs, complete: !failure,
          ...(!materialize ? { stdoutSha256: streams[0]!.hash.digest("hex"), stderrSha256: streams[1]!.hash.digest("hex") } : {}) };
        try {
          const temporary = join(directory, "receipt.tmp");
          await writeFile(temporary, JSON.stringify({ kind: "system_command_output_v1", ...receipt,
            processStatus: result?.status, exitCode: result?.exitCode, spawnedProcess: result?.spawnedProcess,
            ...(failure ? { storageFailure: failure } : {}) }), { flag: "wx", mode: 0o600, flush: true });
          await rename(temporary, join(directory, "receipt.json"));
        } catch {
          failure ??= "receipt_write_failed";
          receipt = { ...receipt, complete: false };
        }
        return { stdout, stderr };
      } finally {
        if (!retained) activeSystemCaptures.delete(directory);
      }
    },
  };
}
