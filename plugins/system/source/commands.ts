import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  readBoundedInteger,
  readRequiredString,
} from "../../../src/plugin-sdk/index.js";
import {
  SystemOperationError,
  type SystemProcessInput,
  type SystemProcessResult,
  type SystemProcessRunner,
  type SystemTarget,
} from "./contracts.js";
import { elevatedSystemCommand } from "./elevation.js";
import { powershellArguments, windowsSystemCommandScript } from "./targets.js";

export async function executeSystemCommand(input: {
  target: SystemTarget;
  params: Record<string, unknown>;
  run: SystemProcessRunner;
  abortSignal?: AbortSignal;
}): Promise<SystemProcessResult> {
  const { target, params, run } = input;
  const command = readRequiredString(params.command, {
    name: "command",
    trim: false,
    maxLength: 4_096,
  });
  const cwd = readRequiredString(params.cwd, { name: "cwd", maxLength: 4_096 });
  const timeoutMs =
    params.timeout_ms === undefined
      ? 60_000
      : readBoundedInteger(params.timeout_ms, {
          name: "timeout_ms",
          minimum: 1_000,
          maximum: 600_000,
        });
  if (hasSystemCommandNullBytes(command, cwd))
    throw new SystemOperationError(
      "system_command_invalid",
      "Commands and directories cannot contain null bytes.",
    );
  if (hasInvalidElevationFlag(params.elevated))
    throw new SystemOperationError(
      "system_command_invalid",
      "elevated must be a boolean.",
    );
  const absoluteCwd =
    target.id === "windows"
      ? hasExplicitWindowsDirectory(cwd)
      : isAbsolute(cwd);
  if (!absoluteCwd)
    throw new SystemOperationError(
      "system_cwd_invalid",
      "System commands require an explicit absolute directory in the selected OS namespace.",
    );
  await requireNativeWorkingDirectory(target, cwd);
  const plan =
    params.elevated === true
      ? await elevatedSystemCommand({ target, command, cwd, run })
      : unprivilegedSystemCommand(target, command, cwd);
  return run({
    ...plan,
    timeoutMs,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  });
}

function unprivilegedSystemCommand(
  target: SystemTarget,
  command: string,
  cwd: string,
): SystemProcessInput {
  if (target.id === "windows")
    return {
      executable: target.shell,
      args: powershellArguments(windowsSystemCommandScript(command, cwd)),
    };
  return { executable: target.shell, args: ["-lc", command], cwd };
}

function hasExplicitWindowsDirectory(path: string): boolean {
  if (/^[a-z]:[\\/]/iu.test(path)) return true;
  return /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(path);
}

function hasSystemCommandNullBytes(command: string, cwd: string): boolean {
  if (command.includes("\0")) return true;
  return cwd.includes("\0");
}
function hasInvalidElevationFlag(value: unknown): boolean {
  if (value === undefined) return false;
  return typeof value !== "boolean";
}
async function requireNativeWorkingDirectory(
  target: SystemTarget,
  cwd: string,
): Promise<void> {
  if (target.id === "windows") return;
  const directory = await stat(cwd).catch(() => undefined);
  if (directory?.isDirectory()) return;
  throw new SystemOperationError(
    "system_cwd_unavailable",
    "The selected target directory is unavailable or not a directory.",
  );
}
