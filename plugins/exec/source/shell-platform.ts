import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { win32 } from "node:path";

import { ExecPluginError } from "./errors.js";

export const EXEC_SHELL = "/bin/bash";

export function execShell(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32")
    return win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  return EXEC_SHELL;
}

function isSupportedExecPlatform(platform: NodeJS.Platform): boolean {
  if (platform === "win32") return true;
  return platform === "linux" || platform === "darwin";
}

export async function assertSupportedShell(
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (!isSupportedExecPlatform(platform)) {
    throw new ExecPluginError(
      "exec_platform_unsupported",
      "The exec plugin requires Linux/macOS with Bash or native Windows with Windows PowerShell.",
    );
  }
  try {
    await access(execShell(platform), constants.X_OK);
  } catch {
    throw new ExecPluginError(
      "exec_shell_unavailable",
      `The exec shell is unavailable: ${execShell(platform)}. No command ran. Do not retry until the user restores shell availability.`,
    );
  }
}
