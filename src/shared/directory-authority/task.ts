import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { directoryAuthorityScript } from "./bootstrap.js";
import { DirectoryAuthorityError } from "./errors.js";
import {
  assertDirectoryAuthorityLocation,
  authorityEnvironment,
  AUTHORITY_MESSAGE_LIMIT,
  AUTHORITY_STDERR_LIMIT,
  AUTHORITY_TASK_TIMEOUT_MS,
  decodeAuthorityResult,
  encodeAuthorityRequest,
  type DirectoryAuthorityLocation,
} from "./protocol.js";

export async function runDirectoryAuthorityTask<Input, Result>(
  input: DirectoryAuthorityLocation &
    Readonly<{
      input: Input;
      task: (input: Input) => Result | Promise<Result>;
      timeoutMs?: number;
      signal?: AbortSignal;
    }>,
): Promise<Result> {
  assertDirectoryAuthorityLocation(input);
  const request = encodeAuthorityRequest(input.input);
  const timeoutMs = input.timeoutMs ?? AUTHORITY_TASK_TIMEOUT_MS;
  const hasPositiveDeadline = Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!hasPositiveDeadline) {
    throw new DirectoryAuthorityError(
      "directory_authority_invalid_timeout",
      "The directory operation deadline must be a positive finite duration.",
    );
  }
  if (input.signal?.aborted) {
    throw new DirectoryAuthorityError(
      "directory_authority_aborted",
      "The directory operation was cancelled before it started.",
    );
  }
  const child = spawn(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      directoryAuthorityScript("task", AUTHORITY_MESSAGE_LIMIT, input.task),
    ],
    {
      cwd: input.directoryPath,
      env: authorityEnvironment(),
      detached: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe", input.directoryFd],
    },
  ) as ChildProcessWithoutNullStreams;

  return new Promise<Result>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let bytes = 0;
    let stderrBytes = 0;
    let failure: DirectoryAuthorityError | undefined;

    const stop = (error: DirectoryAuthorityError): void => {
      if (failure) return;
      failure = error;
      if (typeof child.pid === "number") {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // A process which has already exited may no longer own its group.
        }
      }
      child.kill("SIGKILL");
    };
    const onAbort = (): void =>
      stop(
        new DirectoryAuthorityError(
          "directory_authority_aborted",
          "The directory operation was cancelled.",
        ),
      );
    const timer = setTimeout(
      () =>
        stop(
          new DirectoryAuthorityError(
            "directory_authority_timeout",
            "The directory operation exceeded its deadline.",
          ),
        ),
      timeoutMs,
    );
    timer.unref();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > AUTHORITY_MESSAGE_LIMIT) {
        stop(
          new DirectoryAuthorityError(
            "directory_authority_result_too_large",
            "The directory operation result exceeds the bridge byte limit.",
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = Math.max(AUTHORITY_STDERR_LIMIT - stderrBytes, 0);
      if (remaining === 0) return;
      stderrChunks.push(chunk.subarray(0, remaining));
      stderrBytes += Math.min(chunk.length, remaining);
    });
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => {
      failure ??= new DirectoryAuthorityError(
        "directory_authority_unavailable",
        `The directory operation could not start: ${error.message}`,
      );
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(
          new DirectoryAuthorityError(
            "directory_authority_failed",
            "The directory operation process did not complete successfully.",
            {
              exitCode: code,
              signal,
              stderr: Buffer.concat(stderrChunks).toString("utf8"),
            },
          ),
        );
        return;
      }
      try {
        resolve(
          decodeAuthorityResult<Result>(Buffer.concat(chunks).toString("utf8")),
        );
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(request);
  });
}
