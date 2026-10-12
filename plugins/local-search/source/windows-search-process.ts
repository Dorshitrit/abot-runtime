import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { WINDOWS_EXEC_JOB_SOURCE } from "../../../src/shared/windows-job-object.js";
import { LocalSearchError } from "./errors.js";
import {
  windowsSearchAuthorityUnavailable,
  type WindowsSearchAuthority,
} from "./windows-authority.js";
import { WINDOWS_SEARCH_SOURCE } from "./windows-search-script.js";

const BOOTSTRAP = [
  "$ErrorActionPreference='Stop'",
  "$ProgressPreference='SilentlyContinue'",
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 126 }",
  "$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')",
  "try {",
  "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)",
  "$envelope=[Console]::In.ReadToEnd() | ConvertFrom-Json",
  "Add-Type -TypeDefinition $envelope.jobSource",
  "[AbotExecJob]::Attach()",
  "Add-Type -ReferencedAssemblies @('System.Web.Extensions') -TypeDefinition $envelope.source",
  "$result=[AbotFilesystem]::Search($envelope.request)",
  "exit $result",
  "} catch { exit 126 }",
].join(";\n");

function windowsSearchUnavailable(): LocalSearchError {
  return new LocalSearchError(
    "local_search_windows_unavailable",
    "The Windows local-search helper is unavailable or blocked by computer policy. No results were returned. Do not retry or bypass this restriction with another tool; ask the user to check PowerShell/C# availability or contact their administrator.",
  );
}

function windowsSearchExitFailure(
  code: number | null | undefined,
): LocalSearchError {
  if (code === 125) return windowsSearchAuthorityUnavailable();
  const helperUnavailable = code === 126 || code === undefined;
  if (helperUnavailable) return windowsSearchUnavailable();
  return new LocalSearchError(
    "local_search_failed",
    "Local search could not complete under the selected logical root.",
  );
}

export function spawnWindowsSearch(
  params: Readonly<{
    authority: WindowsSearchAuthority;
    command: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  }>,
) {
  const input = JSON.stringify({
    source: WINDOWS_SEARCH_SOURCE,
    jobSource: WINDOWS_EXEC_JOB_SOURCE,
    request: JSON.stringify({
      ...params.authority,
      command: params.command,
      args: params.args,
    }),
  });
  if (Buffer.byteLength(input) > 2 * 1024 * 1024)
    throw windowsSearchUnavailable();
  const executable = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const child = spawn(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", BOOTSTRAP],
    {
      env: params.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.on("error", () => undefined);
  child.stdin.end(input, "utf8");
  return {
    child: child as unknown as ChildProcessByStdio<null, Readable, Readable>,
    terminate: () => {
      child.kill("SIGKILL");
    },
    failureForExit: windowsSearchExitFailure,
  };
}
