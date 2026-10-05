import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";
import { failureResult, successResult, type ToolImplementation } from "../../plugin-sdk/index.js";
import { MACOS_PERMISSION_HELPER } from "../computer/macos-permission-helper.js";
import { missingMacosComputerPrerequisite } from "../computer/macos-prerequisites.js";
import {
  isMacPermissionAction,
  isMacPermissionStatus,
  MACOS_PERMISSION_OPERATION,
  type MacPermissionAction,
  type MacPermissionResult,
} from "./permission-protocol.js";

const executeFile = promisify(execFile);

/** Launched by the calling Runtime/companion, just like its real Swift computer helper. */
export async function prepareMacPermissions(
  action: MacPermissionAction,
  signal?: AbortSignal,
  dependencies: {
    platform?: string;
    execute?: (file: string, args: string[], options: ExecFileOptionsWithStringEncoding) => Promise<{ stdout: string; stderr: string }>;
    prerequisite?: typeof missingMacosComputerPrerequisite;
  } = {},
): Promise<MacPermissionResult> {
  if ((dependencies.platform ?? process.platform) !== "darwin")
    throw new Error("macos_permissions_platform_required");
  if (!isMacPermissionAction(action)) throw new Error("macos_permissions_input_invalid");
  signal?.throwIfAborted();
  const prerequisite = await (dependencies.prerequisite ?? missingMacosComputerPrerequisite)();
  if (prerequisite) throw new Error(prerequisite);
  const requested = action.action === "request" ? action.permission : "check";
  const output = await (dependencies.execute ?? executeFile)(
    "/usr/bin/swift",
    ["-swift-version", "5", "-e", MACOS_PERMISSION_HELPER, requested],
    { timeout: 45_000, maxBuffer: 16_384, encoding: "utf8", signal },
  );
  const permissions: unknown = JSON.parse(String(output.stdout));
  if (!isMacPermissionStatus(permissions)) throw new Error("macos_permissions_result_invalid");
  return {
    permissions,
    executablePath: process.execPath,
    restartMayBeRequired: requested === "screen_recording",
  };
}

export function createNativePermissionHandlers(
  platform: string,
  prepare = prepareMacPermissions,
): Record<string, ToolImplementation> {
  if (platform !== "macos") return {};
  return {
    [MACOS_PERMISSION_OPERATION]: async (params, context) => {
      const { target, ...action } = params;
      if (target !== "macos" || !isMacPermissionAction(action))
        return failureResult({ errorCode: "macos_permissions_input_invalid", message: "Choose a permission check or one explicit permission request." });
      try {
        const result = await prepare(action, context?.abortSignal);
        return successResult({ output: "Mac permission preparation completed.", data: result });
      } catch {
        return failureResult({
          errorCode: "macos_permissions_check_failed",
          message: "Permission preparation could not complete. Check that macOS 14 or later and Swift developer tools are available, then check again. No desktop content was collected.",
        });
      }
    },
  };
}
