import { spawn } from "node:child_process";
import type { SystemProcessInput, SystemProcessResult } from "./contracts.js";

const STREAM_MAX_CHARS = 16_000;
/** Bounded process observation; exit zero proves command completion, not effects. */
export function runSystemProcess(
  input: SystemProcessInput,
): Promise<SystemProcessResult> {
  if (input.abortSignal?.aborted)
    return Promise.resolve({
      exitCode: null,
      stdout: "",
      stderr: "",
      status: "aborted",
      outputTruncated: false,
    });
  return new Promise((resolve) => {
    const streamMaxChars = Math.min(
      input.outputMaxChars ?? STREAM_MAX_CHARS,
      512_000,
    );
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let status: SystemProcessResult["status"] = "completed";
    let spawnedProcess: SystemProcessResult["spawnedProcess"];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stopGrace: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (stopGrace) clearTimeout(stopGrace);
      input.abortSignal?.removeEventListener("abort", abort);
      resolve(
        Object.freeze({
          exitCode,
          stdout,
          stderr,
          status,
          outputTruncated: truncated,
          ...(spawnedProcess ? { spawnedProcess } : {}),
        }),
      );
    };
    const child = spawn(input.executable, [...input.args], {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    child.once("spawn", () => {
      if (child.pid === undefined) return;
      spawnedProcess = {
        pid: child.pid,
        pidNamespace: "runtime_os",
        executable: input.executable,
        identitySource: "spawn_arguments",
      };
    });
    const stop = (reason: "timeout" | "aborted") => {
      if (settled) return;
      status = reason;
      const pid = child.pid;
      if (pid && process.platform !== "win32") {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
      // Native/external descendants can outlive a stopped transport; never claim
      // their termination from the shell observation alone.
      stopGrace = setTimeout(() => finish(null), 1_000);
      stopGrace.unref();
    };
    const abort = () => stop("aborted");
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const remaining = streamMaxChars - stdout.length;
      truncated ||= chunk.length > remaining;
      stdout += chunk.slice(0, remaining);
    });
    child.stderr.on("data", (chunk: string) => {
      const remaining = streamMaxChars - stderr.length;
      truncated ||= chunk.length > remaining;
      stderr += chunk.slice(0, remaining);
    });
    child.once("error", (error) => {
      status = "spawn_failed";
      stderr = error.message.slice(0, STREAM_MAX_CHARS);
      finish(null);
    });
    child.once("close", (code) => finish(code));
    timeout = setTimeout(() => stop("timeout"), input.timeoutMs ?? 30_000);
    timeout.unref();
    input.abortSignal?.addEventListener("abort", abort, { once: true });
    if (input.abortSignal?.aborted) abort();
  });
}
