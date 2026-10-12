import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { SystemOperationError, type SystemProcessResult } from "./contracts.js";
import type { SystemProcessCapture } from "./process-capture.js";
import { CapturedOutputProtectionError, discardCapturedOutput, protectCapturedOutput,
  type ProtectedOutputBytes } from "./command-output-protection.js";
import { activeSystemCaptures, scheduleSystemOutputCleanup } from "./command-output-retention.js";

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
type OutputStreams = { stdout: string; stderr: string };
const STREAMS = ["stdout", "stderr"] as const;
const OUTPUT_IO_CHUNK_BYTES = 64 * 1024;

/** Private backpressured capture. No read is admitted before complete checks. */
export async function createSystemOutputCapture(root: string, retentionMs: number, redact: (text: string) => string) {
  if (!hasOutputProtection(redact))
    throw new SystemOperationError("system_output_protection_failed", "Command output protection is unavailable. The command was not dispatched.");
  const id = randomUUID();
  const directory = join(root, id);
  activeSystemCaptures.add(directory);
  try { await mkdir(directory, { recursive: true, mode: 0o700 }); }
  catch {
    activeSystemCaptures.delete(directory);
    throw new SystemOperationError("system_output_storage_failed", "Output storage could not be prepared. The command was not dispatched.");
  }
  let storageFailure: string | undefined, securityFailure: string | undefined;
  let stop: (() => void) | undefined;
  let ended = false, retained = false, admitted = false;
  let receipt: SystemOutputReceipt | undefined;
  let processResult: SystemProcessResult | undefined;
  let finishing: Promise<OutputStreams> | undefined;
  const sources: Readable[] = [];
  const completeStreams = new Set<string>();
  const paths = { stdout: join(directory, "stdout.bytes"), stderr: join(directory, "stderr.bytes") };
  const streams = STREAMS.map((name) => {
    const sink = createWriteStream(paths[name], { flags: "wx", mode: 0o600, highWaterMark: OUTPUT_IO_CHUNK_BYTES, flush: true });
    const completion = finished(sink).catch(() => { storageFailure ??= "write_failed"; stop?.(); });
    return { sink, completion };
  });
  try { await Promise.all(streams.map(({ sink }) => once(sink, "open"))); }
  catch {
    for (const { sink } of streams) sink.destroy();
    await Promise.all(streams.map(({ completion }) => completion));
    activeSystemCaptures.delete(directory);
    scheduleSystemOutputCleanup(root, retentionMs);
    throw new SystemOperationError("system_output_storage_failed", "Output files could not be opened. The command was not dispatched.");
  }
  scheduleSystemOutputCleanup(root, retentionMs);
  const failure = () => storageFailure ?? securityFailure;
  const capture: SystemProcessCapture = {
    attach(stdout, stderr, onFailure) {
      if (!canAttachCapture()) { securityFailure ??= "output_protection_failed"; onFailure(); return; }
      stop = onFailure;
      sources.push(stdout, stderr);
      for (const [index, source] of sources.entries()) {
        source.once("end", () => completeStreams.add(STREAMS[index]!));
        source.once("error", () => { securityFailure ??= "output_incomplete"; stop?.(); });
        source.pipe(streams[index]!.sink);
      }
      if (failure()) onFailure();
    },
    end() {
      if (ended) return;
      ended = true;
      if (!hasCompleteStreams()) securityFailure ??= "output_incomplete";
      for (const source of sources) { source.unpipe(); source.destroy(); }
      for (const { sink } of streams) if (!sink.destroyed && !sink.writableEnded) sink.end();
    },
  };
  function canAttachCapture(): boolean { return sources.length === 0 && !ended; }
  function hasCompleteStreams(): boolean { return completeStreams.size === 2; }

  function protectProcess(result: SystemProcessResult | undefined): void {
    if (!result) return;
    let spawnedProcess = result.spawnedProcess;
    if (spawnedProcess) {
      let executable = "[REDACTED]";
      try {
        executable = redact(spawnedProcess.executable);
        if (!hasProtectedIdentity(executable)) throw new Error("output_protection_failed");
      } catch { securityFailure ??= "output_protection_failed"; executable = "[REDACTED]"; }
      spawnedProcess = { ...spawnedProcess, executable };
    }
    processResult = { exitCode: result.exitCode, status: result.status, outputTruncated: result.outputTruncated,
      stdout: "", stderr: "", ...(spawnedProcess ? { spawnedProcess } : {}) };
  }

  async function finish(result?: SystemProcessResult, materialize = true): Promise<OutputStreams> {
    capture.end();
    await Promise.all(streams.map(({ completion }) => completion));
    protectProcess(result);
    let protectedBytes: ProtectedOutputBytes | undefined;
    try {
      if (!failure()) {
        try { protectedBytes = await protectCapturedOutput(paths, redact); }
        catch (error) {
          if (isOutputStorageFailure(error)) storageFailure ??= "write_failed";
          else securityFailure ??= "output_protection_failed";
        }
      }
      if (failure() && !await discardCapturedOutput(paths)) storageFailure = "capture_purge_failed";
      receipt = { id, stdoutBytes: protectedBytes?.stdout.length ?? 0, stderrBytes: protectedBytes?.stderr.length ?? 0,
        completedAt: new Date().toISOString(), retentionMs, complete: !failure(), ...(!materialize && protectedBytes ? {
          stdoutSha256: createHash("sha256").update(protectedBytes.stdout).digest("hex"),
          stderrSha256: createHash("sha256").update(protectedBytes.stderr).digest("hex"),
        } : {}) };
      try {
        const temporary = join(directory, "receipt.tmp");
        await writeFile(temporary, JSON.stringify({ kind: "system_command_output_v1", ...receipt,
          processStatus: processResult?.status, exitCode: processResult?.exitCode, spawnedProcess: processResult?.spawnedProcess,
          ...(securityFailure ? { securityFailure } : {}), ...(storageFailure ? { storageFailure } : {}) }),
        { flag: "wx", mode: 0o600, flush: true });
        await rename(temporary, join(directory, "receipt.json"));
      } catch { storageFailure ??= "receipt_write_failed"; receipt = { ...receipt, complete: false }; }
      admitted = receipt.complete;
      if (!admitted || !materialize || !protectedBytes) return { stdout: "", stderr: "" };
      return { stdout: protectedBytes.stdout.toString("utf8"), stderr: protectedBytes.stderr.toString("utf8") };
    } finally {
      protectedBytes?.stdout.fill(0); protectedBytes?.stderr.fill(0);
      if (!retained) activeSystemCaptures.delete(directory);
    }
  }

  return {
    capture,
    get receipt() { return receipt; },
    get failure() { return failure(); },
    get failureKind() {
      if (storageFailure) return "storage" as const;
      return securityFailure ? "security" as const : undefined;
    },
    get processResult() { return processResult; },
    retain() { retained = true; activeSystemCaptures.add(directory); },
    release() { retained = false; activeSystemCaptures.delete(directory); },
    async read(stream: "stdout" | "stderr", offset: number, length: number): Promise<Buffer> {
      if (!admitted) throw new Error("system_output_unavailable");
      if (!isAdmittedOutputRead(stream, offset, length, receipt!)) throw new Error("system_output_reference_invalid");
      const file = await open(paths[stream], "r");
      try {
        const size = stream === "stdout" ? receipt!.stdoutBytes : receipt!.stderrBytes;
        const bytes = Buffer.alloc(Math.min(length, size - offset));
        const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
        return bytes.subarray(0, bytesRead);
      } finally { await file.close(); }
    },
    finish(result?: SystemProcessResult, materialize = true): Promise<OutputStreams> {
      finishing ??= finish(result, materialize);
      return finishing;
    },
  };
}

function hasOutputProtection(value: unknown): value is (text: string) => string { return typeof value === "function"; }
function hasProtectedIdentity(value: unknown): value is string { return typeof value === "string"; }
function isOutputStorageFailure(error: unknown): boolean {
  return error instanceof CapturedOutputProtectionError && error.reason === "output_storage_failed";
}
function isAdmittedOutputRead(stream: string, offset: number, length: number, receipt: SystemOutputReceipt): boolean {
  if (stream !== "stdout" && stream !== "stderr") return false;
  if (!Number.isSafeInteger(offset) || offset < 0) return false;
  if (!Number.isSafeInteger(length) || length < 0) return false;
  const size = stream === "stdout" ? receipt.stdoutBytes : receipt.stderrBytes;
  return offset <= size;
}
