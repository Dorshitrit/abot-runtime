import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  ComputerPlatform,
  NativeComputerBackend,
  NativeComputerDispatch,
  NativeComputerRequest,
  NativeComputerResult,
} from "./native-protocol.js";
import {
  NATIVE_JSON_LIMIT,
  readUnixDispatch,
  readUnixNativeResult,
  unavailableUnixDesktop,
} from "./unix-native-results.js";

export type UnixNativeProcessOptions = Readonly<{
  platform: ComputerPlatform;
  file: string;
  args: readonly string[];
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
  cancellationGraceMs?: number;
}>;

type PendingNativeRequest = {
  id: string;
  request: NativeComputerRequest;
  finish(result: NativeComputerResult): void;
  dispatch?: NativeComputerDispatch;
};

/** Owns one helper lifetime. Input is never replayed after timeout, abort or process loss. */
export function createUnixNativeProcess(
  options: UnixNativeProcessOptions,
): NativeComputerBackend {
  let child: ChildProcessWithoutNullStreams | undefined;
  let pending: PendingNativeRequest | undefined;
  let closed = false;
  let failedReason: string | undefined;
  let buffer = Buffer.alloc(0);
  let queue = Promise.resolve();
  let lastResult: NativeComputerResult | undefined;

  function interruptedResult(reason: string): NativeComputerResult {
    const dispatch =
      pending?.request.operation === "act"
        ? (pending.dispatch ?? {
            status: "unknown" as const,
            requestedInputCount: 1,
            reason,
          })
        : undefined;
    const result = unavailableUnixDesktop(options.platform, reason, dispatch);
    if (!lastResult) return result;
    return {
      ...result,
      desktop: { ...lastResult.desktop, available: false, reason },
      windows: lastResult.windows,
    };
  }

  function terminate(reason: string): void {
    failedReason = reason;
    pending?.finish(interruptedResult(reason));
    const retiring = child;
    retiring?.kill("SIGTERM");
    if (retiring) {
      const hardStop = setTimeout(() => retiring.kill("SIGKILL"), 3000);
      hardStop.unref();
      retiring.once("exit", () => clearTimeout(hardStop));
    }
    child = undefined;
    buffer = Buffer.alloc(0);
  }

  function receiveLine(line: string): void {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("native_protocol_invalid");
    const message = value as Record<string, unknown>;
    if (!pending || message.id !== pending.id)
      throw new Error("native_response_identity_invalid");
    if (message.type === "dispatch") {
      pending.dispatch = readUnixDispatch(message.dispatch);
      return;
    }
    if (message.type !== "result") throw new Error("native_protocol_invalid");
    const result = readUnixNativeResult(message.result, options.platform);
    lastResult = result;
    pending.finish(result);
  }

  function ensureHelper(): void {
    if (child) return;
    child = (options.spawnProcess ?? spawn)(options.file, [...options.args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    child.stdin.on("error", () => terminate("computer_native_pipe_failed"));
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      if (closed || failedReason) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > NATIVE_JSON_LIMIT) {
        terminate("computer_native_result_limit");
        return;
      }
      let boundary = buffer.indexOf(10);
      while (boundary >= 0) {
        const line = buffer.subarray(0, boundary).toString("utf8");
        buffer = buffer.subarray(boundary + 1);
        try {
          receiveLine(line);
        } catch {
          terminate("computer_native_protocol_invalid");
          return;
        }
        boundary = buffer.indexOf(10);
      }
    });
    child.once("error", () =>
      terminate("computer_native_dependency_unavailable"),
    );
    child.once("exit", () => {
      if (!closed) terminate("computer_native_helper_stopped");
    });
  }

  function executeOne(
    request: NativeComputerRequest,
    signal?: AbortSignal,
  ): Promise<NativeComputerResult> {
    if (closed || failedReason)
      return Promise.resolve(
        unavailableUnixDesktop(
          options.platform,
          failedReason ?? "computer_native_closed",
        ),
      );
    if (signal?.aborted)
      return Promise.resolve(
        unavailableUnixDesktop(
          options.platform,
          "computer_native_aborted",
          request.operation === "act"
            ? {
                status: "not_dispatched",
                requestedInputCount: 1,
                acceptedInputCount: 0,
              }
            : undefined,
        ),
      );
    return new Promise((resolve) => {
      const id = randomUUID();
      let settled = false;
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = setTimeout(
        () => terminate("computer_native_timeout"),
        options.timeoutMs ?? 45_000,
      );
      function finish(result: NativeComputerResult): void {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (cancelTimer) clearTimeout(cancelTimer);
        signal?.removeEventListener("abort", abort);
        pending = undefined;
        resolve(result);
      }
      function abort(): void {
        child?.stdin.write(JSON.stringify({ type: "cancel", id }) + "\n");
        cancelTimer = setTimeout(
          () => terminate("computer_native_cancelled_unknown"),
          options.cancellationGraceMs ?? 1000,
        );
      }
      pending = { id, request, finish };
      try {
        ensureHelper();
        child!.stdin.write(
          JSON.stringify({ type: "request", id, request }) + "\n",
        );
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      } catch {
        terminate("computer_native_dependency_unavailable");
      }
    });
  }

  return {
    execute(request, signal) {
      const result = queue.then(() => executeOne(request, signal));
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    async close() {
      if (closed) return;
      closed = true;
      child?.stdin.write(JSON.stringify({ type: "close" }) + "\n");
      terminate("computer_native_closed");
    },
  };
}
