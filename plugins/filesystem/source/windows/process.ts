import { spawn } from "node:child_process";
import { join } from "node:path";
import { failNotDirectory, FilesystemToolError, isDirectoryTypeFailure } from "../errors.js";
import { WINDOWS_FILESYSTEM_SOURCE } from "./source.js";

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
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
  '} catch { if ($started) { [Console]::Write(\'{"ok":false,"code":"filesystem_windows_operation_unreported"}\') } else { [Console]::Write(\'{"ok":false,"code":"filesystem_windows_helper_unavailable"}\') } }',
].join(";");
const NATIVE_CODES = new Set([
  "file_not_found",
  "file_too_large",
  "not_a_file",
  "not_a_directory",
  "filesystem_access_denied",
  "filesystem_safe_io_unsupported",
  "filesystem_storage_attributes_unsupported",
  "filesystem_named_streams_unsupported",
  "filesystem_windows_publication_unsupported",
  "filesystem_path_changed",
  "filesystem_target_changed",
  "filesystem_invalid_path",
  "filesystem_read_changed",
  "filesystem_read_incomplete",
  "filesystem_invalid_request",
  "filesystem_native_operation_failed",
  "filesystem_windows_policy_blocked",
  "filesystem_windows_helper_unavailable",
]);

export function isWindowsHelperBlocked(
  error: unknown,
): error is FilesystemToolError {
  if (!(error instanceof FilesystemToolError)) return false;
  return (
    error.code === "filesystem_windows_policy_blocked" ||
    error.code === "filesystem_windows_helper_unavailable"
  );
}

function helperFailure(code: string, mutation: boolean): FilesystemToolError {
  if (code === "filesystem_windows_publication_unsupported")
    return new FilesystemToolError(
      code,
      "Windows cannot safely publish this file. Writes require Windows 10 version 1809 or newer and a filesystem supporting hard links, such as NTFS. The destination was left unchanged. Do not retry this write on the same unsupported target.",
      {
        retryable: false,
        blockedBy: "filesystem_publication_support",
        targetUnchanged: true,
      },
    );
  if (code === "filesystem_named_streams_unsupported")
    return new FilesystemToolError(
      code,
      "This file has Windows named data streams, which may include download-origin security information. Editing it is not supported; the original file and its streams were left unchanged. Do not retry this edit or remove the streams to bypass the restriction.",
      {
        retryable: false,
        blockedBy: "file_named_streams",
        targetUnchanged: true,
      },
    );
  if (code === "filesystem_storage_attributes_unsupported")
    return new FilesystemToolError(
      code,
      "This file uses EFS encryption or NTFS compression. Editing it is not supported; the original file was left unchanged. Do not retry this edit or remove its storage attributes to bypass the restriction.",
      {
        retryable: false,
        blockedBy: "file_storage_attributes",
        targetUnchanged: true,
      },
    );
  if (code === "filesystem_windows_policy_blocked")
    return new FilesystemToolError(
      code,
      "Windows policy blocks the filesystem helper. No file operation ran. Retrying cannot resolve this restriction; ask the user to contact their administrator. Do not bypass the restriction.",
      {
        retryable: false,
        blockedBy: "system_policy",
        operationOutcome: "not_started",
      },
    );
  if (code === "filesystem_windows_helper_unavailable")
    return new FilesystemToolError(
      code,
      "The Windows filesystem helper is unavailable. No file operation ran. Do not retry in this request; the user must resolve helper availability first.",
      {
        retryable: false,
        blockedBy: "helper_availability",
        operationOutcome: "not_started",
      },
    );
  return new FilesystemToolError(
    code,
    mutation
      ? "The filesystem helper did not report a completed operation. The file state is unknown; do not repeat the write automatically."
      : "The Windows filesystem helper did not complete the read.",
    {
      retryable: false,
      operationOutcome: mutation ? "unknown" : "not_started",
    },
  );
}

/** One isolated operation. Never changes Windows policy, installs software or retries a write. */
export async function runWindowsFilesystem(
  request: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
  spawnProcess: typeof spawn = spawn,
): Promise<unknown> {
  const mutation = request.operation === "write";
  if (signal?.aborted)
    throw helperFailure("filesystem_windows_interrupted", false);
  const input = JSON.stringify({
    source: WINDOWS_FILESYSTEM_SOURCE,
    request: JSON.stringify(request),
  });
  if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES)
    throw new FilesystemToolError(
      "filesystem_invalid_request",
      "Filesystem helper input exceeds its byte limit.",
    );
  const executable = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawnProcess(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", BOOTSTRAP],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: FilesystemToolError | undefined;
    const stop = (code: string) => {
      failure ??= helperFailure(code, mutation);
      child.kill("SIGKILL");
    };
    const abort = () => stop("filesystem_windows_interrupted");
    const timer = setTimeout(() => stop("filesystem_windows_timeout"), 15_000);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_MESSAGE_BYTES) {
        stop("filesystem_windows_output_limit");
        return;
      }
      chunks.push(chunk);
    });
    // Native diagnostics can contain paths or file contents; never return them as tool evidence.
    child.stderr.resume();
    child.stdin.on("error", () => stop("filesystem_windows_transport_failed"));
    child.once("error", () => {
      failure ??=
        child.pid === undefined
          ? helperFailure("filesystem_windows_helper_unavailable", false)
          : helperFailure("filesystem_windows_transport_failed", mutation);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(helperFailure("filesystem_windows_transport_failed", mutation));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    child.stdin.end(input, "utf8");
  });
  let envelope: { ok?: unknown; result?: unknown; code?: unknown };
  try {
    envelope = JSON.parse(raw) as typeof envelope;
  } catch {
    throw helperFailure("filesystem_windows_response_invalid", mutation);
  }
  if (envelope?.ok === true) return envelope.result;
  const code = typeof envelope?.code === "string" ? envelope.code : "";
  if (!NATIVE_CODES.has(code))
    throw helperFailure("filesystem_windows_response_invalid", mutation);
  if (isDirectoryTypeFailure(code)) failNotDirectory();
  if (
    code === "filesystem_storage_attributes_unsupported" ||
    code === "filesystem_named_streams_unsupported"
  )
    throw helperFailure(code, mutation);
  if (code.startsWith("filesystem_windows_")) throw helperFailure(code, false);
  throw new FilesystemToolError(
    code,
    "The filesystem operation was rejected: " + code + ".",
  );
}
