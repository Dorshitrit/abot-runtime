import { join } from "node:path";
import {
  nativeAutostartFile,
  uninstallNativeAutostart,
  type NativeAutostartOptions,
} from "../computer-access/companion/autostart.js";
import { uninstallCompanionInstallLinks } from "../computer-access/companion/install-link-registration.js";
import { uninstallDesktopNotificationIdentity } from "../computer-access/companion/notification-installation.js";
import type { NativeNotificationSession } from "../computer-access/companion/native-notifications.js";
import type { NativeHostState } from "../computer-access/companion/native-state.js";
import {
  isProcessOwnerAlive,
  requireCurrentProcessOwnerIdentity,
} from "../computer-access/companion/process-owner-identity.js";
import { acquireFileLock } from "../runtime/adapters/long-term-memory/file-lock/acquisition.js";
import { completeHostCompanionStartup } from "./host-companion-startup.js";

/** Packaging owns OS registration; pairing, ownership and supervision stay shared. */
export type HostCompanionLifecycle = Readonly<{
  assertStartupSupported(startup: NativeAutostartOptions): void | Promise<void>;
  completeStartup(
    state: NativeHostState,
    startup: NativeAutostartOptions,
    hostId: string,
  ): Promise<void>;
  uninstall(
    state: NativeHostState,
    startup: NativeAutostartOptions,
  ): Promise<void>;
  createNotifications?(
    runtimeUrl: string,
    signal?: AbortSignal,
  ): Promise<NativeNotificationSession>;
}>;

async function uninstallDefaultCompanion(
  state: NativeHostState,
  startup: NativeAutostartOptions,
): Promise<void> {
  await state.remove();
  await uninstallNativeAutostart(startup);
  await uninstallDesktopNotificationIdentity(startup);
  const ownerIdentity = await requireCurrentProcessOwnerIdentity();
  const release = await acquireFileLock(join(state.directory, "agent"), {
    waitMs: 5_000,
    releaseMode: "synchronous",
    ownerIdentity,
    processIsAlive: isProcessOwnerAlive,
  });
  await release();
  await uninstallCompanionInstallLinks(startup).catch((error: unknown) => {
    console.warn(
      "Plugin installation link cleanup needs attention: " +
        (error instanceof Error ? error.message : String(error)),
    );
  });
  console.log(
    "Host companion stopped. Login startup and the saved credential were removed.",
  );
}

export const defaultHostCompanionLifecycle: HostCompanionLifecycle = {
  assertStartupSupported(startup) {
    nativeAutostartFile(startup);
  },
  completeStartup: completeHostCompanionStartup,
  uninstall: uninstallDefaultCompanion,
};
