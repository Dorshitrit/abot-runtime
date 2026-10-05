import { prepareMacPermissions } from "../computer-access/companion/native-permissions.js";
import type { MacPermissionAction } from "../computer-access/companion/permission-protocol.js";

function permissionCliAction(args: readonly string[]): MacPermissionAction {
  if (args.length === 0) return { action: "check" };
  if (args.length !== 2 || args[0] !== "--request")
    throw new Error("Usage: abot host permissions [--request screen-recording|accessibility]");
  if (args[1] === "screen-recording") return { action: "request", permission: "screen_recording" };
  if (args[1] === "accessibility") return { action: "request", permission: "accessibility" };
  throw new Error("Usage: abot host permissions [--request screen-recording|accessibility]");
}

/** Run from the same Terminal/app that starts ABot; never starts a companion. */
export async function runHostPermissionsCli(
  args: readonly string[],
  dependencies: {
    prepare?: typeof prepareMacPermissions;
    print?: (message: string) => void;
    platform?: string;
  } = {},
): Promise<void> {
  const action = permissionCliAction(args);
  if ((dependencies.platform ?? process.platform) !== "darwin")
    throw new Error("Mac permission preparation is available only on macOS.");
  const result = await (dependencies.prepare ?? prepareMacPermissions)(action);
  (dependencies.print ?? console.log)(JSON.stringify({
    scope: "calling_application",
    ...result,
    guidance: "These permissions belong to the Terminal/app running this command, not the installed companion. Run ABot from this same application. If macOS asks you to quit and reopen it, do so before starting a model session, then check again. App-specific Automation permissions are separate.",
  }, null, 2));
}
