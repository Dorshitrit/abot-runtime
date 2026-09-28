import { spawn } from "node:child_process";

export type NotificationProcessInput = Readonly<{
  file: string;
  args: readonly string[];
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;
export type NotificationProcessRunner = (
  input: NotificationProcessInput,
) => Promise<string>;

/** Native scripts receive notification text as data, never executable source. */
export const runNotificationProcess: NotificationProcessRunner = (input) =>
  new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error("notification_cancelled"));
      return;
    }
    const child = spawn(input.file, [...input.args], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      signal: input.signal,
    });
    let output = "";
    let errors = "";
    let settled = false;
    const deadline = setTimeout(() => {
      child.kill();
      finish(new Error("notification_native_timeout"));
    }, input.timeoutMs ?? 10_000);
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(output);
    }
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (output.length <= 16_384) return;
      child.kill();
      finish(new Error("notification_native_output_limit"));
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      errors = (errors + chunk).slice(-4096);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(errors.trim() || "notification_native_failed"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input.input ?? "");
  });
