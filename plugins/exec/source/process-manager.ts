import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecTerminalDelivery } from "./terminal-delivery.js";
import { createExecProcessOutput } from "./process-output.js";
import { createExecOutputStore } from "./output-store.js";
import {
  execOutputOwner,
  materializeExecOutput,
  type ExecOutputStore,
} from "./output-snapshot.js";

import { ExecPluginError } from "./errors.js";
import { assertSupportedShell, EXEC_SHELL } from "./shell-platform.js";
import type { ExecProcessSnapshot, ExecTerminationReason } from "./types.js";

const MAX_ACTIVE_PROCESSES_PER_SCOPE = 4;

type ExecChild = ChildProcessByStdio<null, Readable, Readable>;

type ManagedExecProcess = {
  processId: string;
  scope: string;
  child: ExecChild;
  startedAt: number;
  cursor: number;
  output: Awaited<ReturnType<typeof createExecProcessOutput>>;
  settling: boolean;
  settled: boolean;
  exitCode?: number;
  terminationReason?: ExecTerminationReason;
  settlePromise: Promise<void>;
  resolveSettled: () => void;
  hardTimeout?: ReturnType<typeof setTimeout>;
  idleTimeout?: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
  onDisposed?: (processId: string) => void;
  transitionTail: Promise<void>;
  terminalDelivery: ExecTerminalDelivery;
  waitInFlight: boolean;
};

export type ExecProcessManager = Readonly<{
  start(
    params: Readonly<{
      scope: string;
      shellCommand: string;
      cwd: string;
      yieldAfterMs: number | null;
      idleTimeoutMs: number;
      hardTimeoutMs: number;
      abortSignal?: AbortSignal;
      onDisposed?: (processId: string) => void;
      onStarted?: (processId: string, settled: Promise<void>) => void;
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
  snapshotSettled(
    processId: string,
    scope: string,
  ): Readonly<{ cursor: number; snapshot: ExecProcessSnapshot }>;
}>;

export type ExecProcessDeliveryManager = ExecProcessManager &
  Readonly<{
    accept(snapshot: ExecProcessSnapshot, scope: string): Promise<void>;
    reject(snapshot: ExecProcessSnapshot, scope: string): Promise<void>;
  }>;

export function createExecProcessManager(
  store: ExecOutputStore = createExecOutputStore({
    stateDir: join(tmpdir(), "abot-exec"),
  }),
): ExecProcessDeliveryManager {
  const processes = new Map<string, ManagedExecProcess>();
  const opening = new Map<string, number>();

  const unknownProcess = (): ExecPluginError =>
    new ExecPluginError(
      "unknown_exec_process",
      "The exec process is unknown to this plugin instance and session.",
    );

  const dispose = (managed: ManagedExecProcess): void => {
    processes.delete(managed.processId);
    managed.onDisposed?.(managed.processId);
  };

  const activeProcessCount = (scope: string): number =>
    [...processes.values()].filter(
      (managed) => managed.scope === scope && !managed.settled,
    ).length + (opening.get(scope) ?? 0);

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
    if (reason === "output_storage_failed") {
      // A failed sink cannot drain the pipes; close them so child close settles.
      managed.child.stdout.destroy();
      managed.child.stderr.destroy();
    }
  };

  const scheduleIdleTimeout = (
    managed: ManagedExecProcess,
    idleTimeoutMs: number,
  ): void => {
    if (managed.settling || managed.settled) return;
    if (managed.idleTimeout) clearTimeout(managed.idleTimeout);
    managed.idleTimeout = setTimeout(
      () => requestTermination(managed, "idle_timeout"),
      idleTimeoutMs,
    );
    managed.idleTimeout.unref?.();
  };

  const settle = async (
    managed: ManagedExecProcess,
    exitCode: number,
    fallbackReason: ExecTerminationReason,
  ): Promise<void> => {
    if (managed.settling || managed.settled) return;
    managed.settling = true;
    if (managed.hardTimeout) clearTimeout(managed.hardTimeout);
    if (managed.idleTimeout) clearTimeout(managed.idleTimeout);
    await managed.output.finish();
    managed.settled = true;
    if (managed.output.checkpoint().outputFailure)
      managed.terminationReason = "output_storage_failed";
    managed.terminationReason ??= fallbackReason;
    managed.exitCode =
      managed.terminationReason === "hard_timeout" ||
      managed.terminationReason === "idle_timeout"
        ? 124
        : managed.terminationReason === "cancelled" ||
            managed.terminationReason === "aborted"
          ? 130
          : managed.terminationReason === "output_storage_failed"
            ? -1
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
  };

  const peekSnapshot = async (
    managed: ManagedExecProcess,
  ): Promise<ExecProcessSnapshot> => {
    managed.terminalDelivery.assertAvailable();
    const status = managed.settled ? "settled" : "running";
    const output = await managed.output.peek();
    if (output.outputFailure && !managed.settled) {
      requestTermination(managed, "output_storage_failed");
      await managed.settlePromise;
      return peekSnapshot(managed);
    }
    const snapshot = await materializeExecOutput(
      store,
      managed.scope,
      Object.freeze({
        processId: managed.processId,
        status,
        nextCursor: managed.cursor,
        ...(managed.exitCode === undefined
          ? {}
          : { exitCode: managed.exitCode }),
        ...output,
        ...(managed.terminationReason
          ? { terminationReason: managed.terminationReason }
          : {}),
        elapsedMs: Date.now() - managed.startedAt,
      }),
    );
    if (snapshot.outputFailure && !managed.settled) {
      requestTermination(managed, "output_storage_failed");
      await managed.settlePromise;
      return peekSnapshot(managed);
    }
    return managed.terminalDelivery.reserve(snapshot);
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
      opening.set(params.scope, (opening.get(params.scope) ?? 0) + 1);
      const processId = `exec_${randomUUID()}`;
      let output: ManagedExecProcess["output"];
      try {
        await store.cleanupExpired();
        output = await createExecProcessOutput(
          store,
          execOutputOwner(params.scope, processId),
        );
        if (params.abortSignal?.aborted) {
          await output.dispose();
          params.abortSignal.throwIfAborted();
        }
      } finally {
        const count = opening.get(params.scope)! - 1;
        if (count) opening.set(params.scope, count);
        else opening.delete(params.scope);
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
        await output.dispose();
        throw new ExecPluginError(
          "exec_spawn_failed",
          "The runtime could not start the configured non-interactive shell.",
        );
      }
      const managed: ManagedExecProcess = {
        processId,
        scope: params.scope,
        child,
        startedAt: Date.now(),
        cursor: 1,
        output,
        settling: false,
        settled: false,
        settlePromise,
        resolveSettled,
        transitionTail: Promise.resolve(),
        terminalDelivery: new ExecTerminalDelivery(),
        waitInFlight: false,
        ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
        ...(params.onDisposed ? { onDisposed: params.onDisposed } : {}),
      };
      processes.set(managed.processId, managed);
      params.onStarted?.(managed.processId, managed.settlePromise);

      output.attach(
        child,
        () => scheduleIdleTimeout(managed, params.idleTimeoutMs),
        () => requestTermination(managed, "output_storage_failed"),
      );
      child.on("error", () => {
        void settle(managed, -1, "spawn_failed");
      });
      child.on("close", (code) => {
        void settle(managed, typeof code === "number" ? code : -1, "completed");
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
      return peekSnapshot(managed);
    },

    async wait(params) {
      const managed = getScopedProcess(params.processId, params.scope);
      await withProcessTransition(managed, () => {
        managed.terminalDelivery.assertAvailable();
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
        managed.terminalDelivery.assertAvailable();
        return peekSnapshot(managed);
      });
    },

    async cancel(params) {
      const managed = getScopedProcess(params.processId, params.scope);
      return withProcessTransition(managed, async () => {
        managed.terminalDelivery.assertAvailable();
        if (!managed.settled) {
          requestTermination(managed, "cancelled");
          await managed.settlePromise;
        }
        return peekSnapshot(managed);
      });
    },

    snapshotSettled(processId, scope) {
      const managed = getScopedProcess(processId, scope);
      if (
        !managed.settled ||
        managed.waitInFlight ||
        managed.terminalDelivery.isClaimed
      )
        throw new Error("exec_snapshot_not_quiescent");
      return Object.freeze({
        cursor: managed.cursor,
        snapshot: Object.freeze({
          processId,
          status: "settled" as const,
          ...(managed.exitCode === undefined
            ? {}
            : { exitCode: managed.exitCode }),
          ...managed.output.checkpoint(),
          ...(managed.terminationReason
            ? { terminationReason: managed.terminationReason }
            : {}),
          elapsedMs: Date.now() - managed.startedAt,
        }),
      });
    },
    async accept(snapshot, scope) {
      // Abort already releases its process; preserve its terminal receipt.
      const wasReleasedAfterAbort =
        snapshot.terminationReason === "aborted" &&
        !processes.has(snapshot.processId);
      if (wasReleasedAfterAbort) return;
      const managed = getScopedProcess(snapshot.processId, scope);
      await withProcessTransition(managed, async () => {
        managed.terminalDelivery.assertOwner(snapshot);
        if (snapshot.nextCursor !== managed.cursor) {
          throw new ExecPluginError(
            "stale_exec_process_cursor",
            "The output receipt no longer matches the current exec cursor.",
          );
        }
        await managed.output.accept(snapshot);
        managed.terminalDelivery.accept(snapshot);
      });
    },
    async reject(snapshot, scope) {
      const managed = processes.get(snapshot.processId);
      if (!managed) return;
      if (managed.scope !== scope) throw unknownProcess();
      await withProcessTransition(managed, () => {
        managed.terminalDelivery.reject(snapshot);
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
