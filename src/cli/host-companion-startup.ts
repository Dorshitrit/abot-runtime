import { spawn } from "node:child_process";
import { installDesktopNotificationIdentity } from "../computer-access/companion/notification-installation.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  installNativeAutostart,
  existingOwnedRegistration,
  nativeAutostartFile,
  type NativeAutostartOptions,
} from "../computer-access/companion/autostart.js";
import type { NativeHostState } from "../computer-access/companion/native-state.js";
import { readNativeCompanionBuildId } from "../computer-access/companion/native-build-identity.js";
import { stopOwnedNativeCompanion } from "../computer-access/companion/native-replacement.js";
import { prepareNativeCompanionRuntime } from "../computer-access/companion/native-runtime-installation.js";

async function startDetachedCompanion(
  options: NativeAutostartOptions,
): Promise<void> {
  const child = spawn(options.nodePath, [options.cliPath, "host", "run"], {
    cwd: options.homeDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

async function waitForNativeConnection(
  state: NativeHostState,
  hostId: string,
  buildId: string,
  connectedAfter: number,
): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  do {
    if (await state.isConnected(hostId, buildId, connectedAfter)) return true;
    await delay(200);
  } while (Date.now() < deadline);
  return false;
}

/** Startup can be resumed without consuming another grant or changing the saved pairing. */
export async function completeHostCompanionStartup(
  state: NativeHostState,
  startup: NativeAutostartOptions,
  hostId: string,
): Promise<void> {
  const buildId = await readNativeCompanionBuildId(startup.cliPath);
  await existingOwnedRegistration(nativeAutostartFile(startup));
  await stopOwnedNativeCompanion(state.directory);
  const managedStartup = await prepareNativeCompanionRuntime(startup);
  const connection = await state.read();
  if (connection)
    await installDesktopNotificationIdentity(
      managedStartup,
      connection.url,
    ).catch((error: unknown) => {
      console.warn(
        "Desktop notifications setup needs attention: " +
          (error instanceof Error ? error.message : String(error)),
      );
    });
  const connectedAfter = Date.now();
  const installed = await installNativeAutostart(managedStartup);
  if (!installed.started) await startDetachedCompanion(managedStartup);
  if (!(await waitForNativeConnection(state, hostId, buildId, connectedAfter)))
    throw new Error(
      "The updated host companion did not connect. The saved pairing is preserved; run setup again to retry.",
    );
  console.log(
    "Host companion connected. It will start automatically when you log in.",
  );
}
