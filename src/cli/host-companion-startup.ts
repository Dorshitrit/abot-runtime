import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  installNativeAutostart,
  type NativeAutostartOptions,
} from "../../plugins/system/source/companion/autostart.js";
import type { NativeHostState } from "../../plugins/system/source/companion/native-state.js";

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
): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  do {
    if (await state.isConnected(hostId)) return true;
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
  const installed = await installNativeAutostart(startup);
  if (!installed.started) await startDetachedCompanion(startup);
  const connected = await waitForNativeConnection(state, hostId);
  console.log(
    connected
      ? "Host companion connected. It will start automatically when you log in."
      : "Host companion installed for login startup. It is waiting for the local Runtime to reconnect.",
  );
}
