import { spawn } from "node:child_process";
import { join } from "node:path";
import { WINDOWS_BOUNDED_READ_SOURCE } from "./read-script.js";
import { windowsReadAbortError, windowsReadError } from "./result.js";

const BOOTSTRAP = [
  "$ErrorActionPreference='Stop'",
  'if ($ExecutionContext.SessionState.LanguageMode -ne \'FullLanguage\') { Write-Output \'{"ok":false,"code":"filesystem_windows_policy_blocked"}\'; exit 0 }',
  "$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')",
  "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)",
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
  "$started=$false",
  "try {",
  "$envelope=[Console]::In.ReadToEnd() | ConvertFrom-Json",
  "Add-Type -ReferencedAssemblies @('System.Web.Extensions') -TypeDefinition $envelope.source",
  "$started=$true",
  "[Console]::Write([AbotFilesystem]::Run($envelope.request))",
  '} catch { if ($started) { [Console]::Write(\'{"ok":false,"code":"filesystem_native_operation_failed"}\') } else { [Console]::Write(\'{"ok":false,"code":"filesystem_windows_helper_unavailable"}\') } }',
].join(";");

const UNAVAILABLE = '{"ok":false,"code":"filesystem_windows_helper_unavailable"}';

/** Read-only helper. Never alters execution policy, retries, or reads through a fallback. */
export async function runWindowsBoundedRead(
  request: Readonly<Record<string, unknown>>,
  maxBytes: number,
  signal?: AbortSignal,
  spawnProcess: typeof spawn = spawn,
): Promise<string> {
  if (signal?.aborted) throw windowsReadAbortError();
  const input = JSON.stringify({
    source: WINDOWS_BOUNDED_READ_SOURCE,
    request: JSON.stringify(request),
  });
  if (Buffer.byteLength(input) > 2 * 1024 * 1024)
    throw windowsReadError("EINVAL");
  const outputLimit = 4 * Math.ceil(Math.min(maxBytes, 2_147_483_647) / 3) + 4096;
  const executable = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );
  return new Promise<string>((resolve, reject) => {
    const child = spawnProcess(executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", BOOTSTRAP],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let byteCount = 0;
    let failure: Error | undefined;
    let unavailable = false;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const abort = () => stop(windowsReadAbortError());
    const timer = setTimeout(() => stop(windowsReadError("ETIMEDOUT")), 15_000);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      byteCount += chunk.length;
      if (byteCount > outputLimit) {
        stop(windowsReadError("EOVERFLOW"));
        return;
      }
      chunks.push(chunk);
    });
    // Compiler/native diagnostics may contain private paths. Never expose them.
    child.stderr.resume();
    child.stdin.on("error", () => {
      if (child.pid === undefined) return;
      stop(windowsReadError("EIO"));
    });
    child.once("error", () => {
      if (child.pid === undefined) { unavailable = true; return; }
      stop(windowsReadError("EIO"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) { reject(failure); return; }
      if (unavailable) { resolve(UNAVAILABLE); return; }
      if (code !== 0) { reject(windowsReadError("EIO")); return; }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    if (signal?.aborted) { abort(); return; }
    child.stdin.end(input, "utf8");
  });
}
