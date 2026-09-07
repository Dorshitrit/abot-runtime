import { constants } from "node:fs";
import { access } from "node:fs/promises";

import { ExecPluginError } from "./errors.js";

export const EXEC_SHELL = "/bin/bash";

function isSupportedExecPlatform(platform: NodeJS.Platform): boolean {
  return platform === "linux" || platform === "darwin";
}

export async function assertSupportedShell(
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (!isSupportedExecPlatform(platform)) {
    throw new ExecPluginError(
      "exec_platform_unsupported",
      "The exec plugin requires Linux or macOS and executable /bin/bash.",
    );
  }
  try {
    await access(EXEC_SHELL, constants.X_OK);
  } catch {
    throw new ExecPluginError(
      "exec_shell_unavailable",
      "The exec plugin cannot start because executable /bin/bash is unavailable.",
    );
  }
}
