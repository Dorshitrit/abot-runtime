import type { HostCompanionLifecycle } from "../../../cli/host-companion-lifecycle.js";
import {
  startDetachedCompanion,
  waitForNativeConnection,
} from "../../../cli/host-companion-startup.js";
import {
  existingOwnedRegistration,
  nativeAutostartFile,
  uninstallNativeAutostart,
  type NativeAutostartOptions,
} from "../autostart.js";
import { uninstallCompanionInstallLinks } from "../install-link-registration.js";
import { readNativeCompanionBuildId } from "../native-build-identity.js";
import { createNotificationSession } from "../native-notifications.js";
import { stopOwnedNativeCompanion } from "../native-replacement.js";
import { uninstallDesktopNotificationIdentity } from "../notification-installation.js";
import { runNotificationProcess } from "../notification-process.js";
import {
  powershellNotificationArguments,
  sendWindowsNotification,
} from "../notification-windows.js";

const STORE_NOTIFICATION_READINESS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $Payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $Notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier([string]$Payload.appUserModelId)
  [Console]::Out.Write([string]$Notifier.Setting)
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
  exit 1
}
`;

function assertWindowsStoreStartup(startup: NativeAutostartOptions): void {
  if (startup.platform !== "win32")
    throw new Error("The Store companion requires Windows.");
}

function requireStoreApplicationIdentity(appUserModelId: string): void {
  if (!/^[A-Za-z0-9.-]+_[A-Za-z0-9]+![A-Za-z0-9.-]+$/u.test(appUserModelId))
    throw new Error("Invalid Store companion application identity.");
}

async function hasWindowsStoreNotificationSupport(
  appUserModelId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  try {
    const setting = await runNotificationProcess({
      file: "powershell.exe",
      args: powershellNotificationArguments(
        STORE_NOTIFICATION_READINESS_SCRIPT,
      ),
      input: JSON.stringify({ appUserModelId }),
      signal,
    });
    signal?.throwIfAborted();
    return setting.trim() === "Enabled";
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

/** Called only after the Store connection dialog has obtained the user's consent. */
async function retireOwnedLegacyRegistration(
  startup: NativeAutostartOptions,
): Promise<void> {
  await existingOwnedRegistration(nativeAutostartFile(startup));
  await stopOwnedNativeCompanion(startup.stateDir);
  await uninstallNativeAutostart(startup);
  await uninstallCompanionInstallLinks(startup);
  await uninstallDesktopNotificationIdentity(startup);
}

/** MSIX owns startup/protocol registration and updates; the shared CLI owns pairing. */
export function createWindowsStoreLifecycle(
  options: Readonly<{
    appUserModelId: string;
  }>,
): HostCompanionLifecycle {
  requireStoreApplicationIdentity(options.appUserModelId);
  return {
    assertStartupSupported: assertWindowsStoreStartup,
    async completeStartup(state, startup, hostId) {
      assertWindowsStoreStartup(startup);
      const buildId = await readNativeCompanionBuildId(startup.cliPath);
      await retireOwnedLegacyRegistration(startup);
      const connectedAfter = Date.now();
      await startDetachedCompanion(startup);
      if (
        !(await waitForNativeConnection(state, hostId, buildId, connectedAfter))
      )
        throw new Error(
          "The Store companion did not connect. The saved pairing is preserved; use Connect computer again to retry.",
        );
      console.log("ABot AI Companion connected.");
    },
    async uninstall(state, startup) {
      assertWindowsStoreStartup(startup);
      await state.remove();
      await stopOwnedNativeCompanion(state.directory);
      console.log(
        "Host companion disconnected and its saved credential was removed. Remove ABot AI Companion in Windows Settings to uninstall the app.",
      );
    },
    async createNotifications(runtimeUrl, signal) {
      signal?.throwIfAborted();
      const { appUserModelId } = options;
      // The supervisor already refreshes readiness and renegotiates capabilities.
      // A slow Windows notification probe must not consume the pairing startup deadline.
      return createNotificationSession(
        "windows",
        runtimeUrl,
        false,
        {
          send: (notification, sendSignal) =>
            sendWindowsNotification(
              notification,
              sendSignal,
              runNotificationProcess,
              appUserModelId,
            ),
          close() {},
        },
        (refreshSignal) =>
          hasWindowsStoreNotificationSupport(appUserModelId, refreshSignal),
      );
    },
  };
}
