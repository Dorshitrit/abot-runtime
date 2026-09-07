import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { sanitizeJsonText } from "../../../src/plugin-sdk/index.js";

import { ExecPluginError } from "./errors.js";
import { assertSupportedShell, EXEC_SHELL } from "./shell-platform.js";
import type {
  ExecProcessSnapshot,
  ExecStreamSnapshot,
  ExecTerminationReason,
} from "./types.js";

const COMPLETED_PROCESS_RETENTION_MS = 5 * 60_000;
const MAX_ACTIVE_PROCESSES_PER_SCOPE = 4;

type ExecChild = ChildProcessByStdio<null, Readable, Readable>;

class CappedTextBuffer {
  private text = "";
  private originalChars = 0;
  private omittedChars = 0;
  private sawOutput = false;

  constructor(private readonly maxChars: number) {}

  append(chunk: string): void {
    if (!chunk) return;
    const safeChunk = sanitizeJsonText(chunk);
    this.sawOutput = true;
    this.originalChars += safeChunk.length;
    const available = Math.max(this.maxChars - this.text.length, 0);
    this.text += safeChunk.slice(0, available);
    this.omittedChars += Math.max(safeChunk.length - available, 0);
  }

  consume(): ExecStreamSnapshot {
    const text = this.text;
    const originalChars = this.originalChars;
    const omittedChars = this.omittedChars;
    this.text = "";
    this.originalChars = 0;
    this.omittedChars = 0;
    return Object.freeze({
      text,
      sawOutput: this.sawOutput,
      metadata: Object.freeze({
        truncated: omittedChars > 0,
        originalChars,
        returnedChars: text.length,
        omittedChars,
      }),
    });
  }
}

type ManagedExecProcess = {
  processId: string;
  scope: string;
  child: ExecChild;
  startedAt: number;
  cursor: number;
  stdout: CappedTextBuffer;
  stderr: CappedTextBuffer;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  settled: boolean;
  exitCode?: number;
  terminationReason?: ExecTerminationReason;
  settlePromise: Promise<void>;
  resolveSettled: () => void;
  hardTimeout?: ReturnType<typeof setTimeout>;
  idleTimeout?: ReturnType<typeof setTimeout>;
  retentionTimeout?: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
  onDisposed?: (processId: string) => void;
  transitionTail: Promise<void>;
  terminalSnapshotClaimed: boolean;
  waitInFlight: boolean;
};

export type ExecProcessManager = Readonly<{
  start(
    params: Readonly<{
      scope: string;
      shellCommand: string;
      cwd: string;
      outputMaxChars: number;
      yieldAfterMs: number | null;
      idleTimeoutMs: number;
      hardTimeoutMs: number;
      abortSignal?: AbortSignal;
      onDisposed?: (processId: string) => void;
    }>,
  ): Promise<ExecProcessSnapshot>;
  wait(
    params: Readonly<{
      processId: string;
      scope: string;
      cursor: number;
      waitMs: number;
    }>,
  ): Promise<ExecProcessSnapshot>;
  cancel(
    params: Readonly<{
      processId: string;
      scope: string;
    }>,
  ): Promise<ExecProcessSnapshot>;
  release(processId: string, scope: string): Promise<void>;
}>;

export function createExecProcessManager(): ExecProcessManager {
  const processes = new Map<string, ManagedExecProcess>();

  const unknownProcess = (): ExecPluginError =>
    new ExecPluginError(
      "unknown_exec_process",
      "The exec process is unknown to this plugin instance and session.",
    );

  const dispose = (managed: ManagedExecProcess): void => {
    if (managed.retentionTimeout) clearTimeout(managed.retentionTimeout);
    processes.delete(managed.processId);
    managed.onDisposed?.(managed.processId);
  };

  const activeProcessCount = (scope: string): number =>
    [...processes.values()].filter(
      (managed) => managed.scope === scope && !managed.settled,
    ).length;

  const killProcessTree = (managed: ManagedExecProcess): void => {
    const pid = managed.child.pid;
    if (typeof pid === "number") {
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
        // Fall through to the direct child as a best-effort fallback.
      }
    }
    managed.child.kill("SIGKILL");
  };

  const requestTermination = (
    managed: ManagedExecProcess,
    reason: ExecTerminationReason,
  ): void => {
    if (managed.settled || managed.terminationReason) return;
    managed.terminationReason = reason;
    killProcessTree(managed);
  };

  const scheduleIdleTimeout = (
    managed: ManagedExecProcess,
    idleTimeoutMs: number,
  ): void => {
    if (managed.idleTimeout) clearTimeout(managed.idleTimeout);
    managed.idleTimeout = setTimeout(
      () => requestTermination(managed, "idle_timeout"),
      idleTimeoutMs,
    );
    managed.idleTimeout.unref?.();
  };

  const settle = (
    managed: ManagedExecProcess,
    exitCode: number,
    fallbackReason: ExecTerminationReason,
  ): void => {
    if (managed.settled) return;
    managed.settled = true;
    managed.terminationReason ??= fallbackReason;
    managed.exitCode =
      managed.terminationReason === "hard_timeout" ||
      managed.terminationReason === "idle_timeout"
        ? 124
        : managed.terminationReason === "cancelled" ||
            managed.terminationReason === "aborted"
          ? 130
          : exitCode;
    if (managed.hardTimeout) clearTimeout(managed.hardTimeout);
    if (managed.idleTimeout) clearTimeout(managed.idleTimeout);
    if (managed.abortSignal && managed.abortListener) {
      managed.abortSignal.removeEventListener("abort", managed.abortListener);
    }
    managed.resolveSettled();
    if (managed.terminationReason === "aborted") {
      dispose(managed);
      return;
    }
    managed.retentionTimeout = setTimeout(
      () => dispose(managed),
      COMPLETED_PROCESS_RETENTION_MS,
    );
    managed.retentionTimeout.unref?.();
  };

  const consumeSnapshot = (
    managed: ManagedExecProcess,
  ): ExecProcessSnapshot => {
    if (managed.settled) {
      if (managed.terminalSnapshotClaimed) throw unknownProcess();
      managed.terminalSnapshotClaimed = true;
    }
    return Object.freeze({
      processId: managed.processId,
      status: managed.settled ? "settled" : "running",
      ...(!managed.settled ? { nextCursor: managed.cursor } : {}),
      ...(managed.exitCode === undefined ? {} : { exitCode: managed.exitCode }),
      stdout: managed.stdout.consume(),
      stderr: managed.stderr.consume(),
      ...(managed.terminationReason
        ? { terminationReason: managed.terminationReason }
        : {}),
      elapsedMs: Date.now() - managed.startedAt,
    });
  };

  const waitForSettlement = async (
    managed: ManagedExecProcess,
    waitMs: number,
  ): Promise<void> => {
    if (managed.settled) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      managed.settlePromise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, waitMs);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  };

  const getScopedProcess = (
    processId: string,
    scope: string,
  ): ManagedExecProcess => {
    const managed = processes.get(processId);
    if (!managed || managed.scope !== scope) {
      throw unknownProcess();
    }
    return managed;
  };

  const withProcessTransition = async <T>(
    managed: ManagedExecProcess,
    operation: () => Promise<T> | T,
  ): Promise<T> => {
    const previous = managed.transitionTail;
    let releaseTransition: () => void = () => undefined;
    managed.transitionTail = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });
    await previous;
    try {
      if (processes.get(managed.processId) !== managed) throw unknownProcess();
      return await operation();
    } finally {
      releaseTransition();
    }
  };

  return Object.freeze({
    async start(params) {
      await assertSupportedShell();
      if (activeProcessCount(params.scope) >= MAX_ACTIVE_PROCESSES_PER_SCOPE) {
        throw new ExecPluginError(
          "exec_process_limit_reached",
          `The session already has ${MAX_ACTIVE_PROCESSES_PER_SCOPE} active exec processes.`,
        );
      }
      let resolveSettled: () => void = () => undefined;
      const settlePromise = new Promise<void>((resolve) => {
        resolveSettled = resolve;
      });
      let child: ExecChild;
      try {
        child = spawn(EXEC_SHELL, ["-lc", params.shellCommand], {
          cwd: params.cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        throw new ExecPluginError(
          "exec_spawn_failed",
          "The runtime could not start the configured non-interactive shell.",
        );
      }
      const managed: ManagedExecProcess = {
        processId: `exec_${randomUUID()}`,
        scope: params.scope,
        child,
        startedAt: Date.now(),
        cursor: 1,
        stdout: new CappedTextBuffer(params.outputMaxChars),
        stderr: new CappedTextBuffer(params.outputMaxChars),
        stdoutDecoder: new StringDecoder("utf8"),
        stderrDecoder: new StringDecoder("utf8"),
        settled: false,
        settlePromise,
        resolveSettled,
        transitionTail: Promise.resolve(),
        terminalSnapshotClaimed: false,
        waitInFlight: false,
        ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
        ...(params.onDisposed ? { onDisposed: params.onDisposed } : {}),
      };
      processes.set(managed.processId, managed);

      const observe = (stream: "stdout" | "stderr", chunk: string): void => {
        if (managed.settled || !chunk) return;
        if (stream === "stdout") managed.stdout.append(chunk);
        else managed.stderr.append(chunk);
        scheduleIdleTimeout(managed, params.idleTimeoutMs);
      };
      child.stdout.on("data", (chunk: Buffer) =>
        observe("stdout", managed.stdoutDecoder.write(chunk)),
      );
      child.stderr.on("data", (chunk: Buffer) =>
        observe("stderr", managed.stderrDecoder.write(chunk)),
      );
      child.on("error", () => settle(managed, -1, "spawn_failed"));
      child.on("close", (code) => {
        observe("stdout", managed.stdoutDecoder.end());
        observe("stderr", managed.stderrDecoder.end());
        settle(managed, typeof code === "number" ? code : -1, "completed");
      });
      managed.hardTimeout = setTimeout(
        () => requestTermination(managed, "hard_timeout"),
        params.hardTimeoutMs,
      );
      managed.hardTimeout.unref?.();
      scheduleIdleTimeout(managed, params.idleTimeoutMs);
      if (params.abortSignal) {
        managed.abortListener = () => requestTermination(managed, "aborted");
        if (params.abortSignal.aborted) managed.abortListener();
        else {
          params.abortSignal.addEventListener("abort", managed.abortListener, {
            once: true,
          });
        }
      }

      if (
        params.yieldAfterMs === null ||
        params.yieldAfterMs >= params.hardTimeoutMs
      ) {
        await managed.settlePromise;
      } else {
        await waitForSettlement(managed, params.yieldAfterMs);
      }
      return consumeSnapshot(managed);
    },

    async wait(params) {
      const managed = getScopedProcess(params.processId, params.scope);
      await withProcessTransition(managed, () => {
        if (managed.terminalSnapshotClaimed) throw unknownProcess();
        if (managed.waitInFlight) {
          throw new ExecPluginError(
            "exec_wait_in_progress",
            "Another wait is already observing this exec process.",
          );
        }
        if (params.cursor !== managed.cursor) {
          throw new ExecPluginError(
            "stale_exec_process_cursor",
            `The exec cursor is stale; expected ${managed.cursor}.`,
          );
        }
        managed.waitInFlight = true;
        if (!managed.settled) managed.cursor += 1;
      });
      await waitForSettlement(managed, params.waitMs);
      return withProcessTransition(managed, () => {
        managed.waitInFlight = false;
        if (managed.terminalSnapshotClaimed) throw unknownProcess();
        return consumeSnapshot(managed);
      });
    },

    async cancel(params) {
      const managed = getScopedProcess(params.processId, params.scope);
      return withProcessTransition(managed, async () => {
        if (managed.terminalSnapshotClaimed) throw unknownProcess();
        if (!managed.settled) {
          requestTermination(managed, "cancelled");
          await managed.settlePromise;
        }
        return consumeSnapshot(managed);
      });
    },

    async release(processId, scope) {
      const managed = processes.get(processId);
      if (!managed) return;
      if (managed.scope !== scope) {
        throw unknownProcess();
      }
      await withProcessTransition(managed, () => {
        if (managed.settled) dispose(managed);
      });
    },
  });
}
