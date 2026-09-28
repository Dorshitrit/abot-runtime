import {
  failureResult,
  successResult,
  type ToolImplementation,
} from "../../plugin-sdk/index.js";
import type { HostIdentity } from "./protocol.js";
import {
  readDesktopNotification,
  type DesktopNotification,
} from "./notification-protocol.js";
import {
  defaultNotificationLocations,
  type NotificationLocations,
} from "./notification-locations.js";
import { sendWindowsNotification } from "./notification-windows.js";
import { sendMacNotification } from "./notification-macos.js";
import { LinuxNotificationRenderer } from "./notification-linux.js";
import { stopMacNotificationApp } from "./notification-installation.js";
import { runNotificationProcess } from "./notification-process.js";
import { hasDesktopNotificationSupport } from "./notification-readiness.js";
import { NotificationReadinessState } from "./notification-readiness-state.js";

export type NativeNotificationSession = Readonly<{
  ready: boolean;
  refreshReadiness?(signal: AbortSignal): Promise<boolean>;
  handlers(): Record<string, ToolImplementation>;
  close(): void | Promise<void>;
}>;
export type NativeNotificationRenderer = Readonly<{
  send(notification: DesktopNotification, signal?: AbortSignal): Promise<void>;
  close(): void | Promise<void>;
}>;

function hasUnknownNotificationOutcome(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  if (error.message === "notification_native_timeout") return true;
  return error.message === "notification_cancelled";
}

export function createNotificationSession(
  platform: HostIdentity["os"],
  runtimeUrl: string,
  ready: boolean,
  renderer: NativeNotificationRenderer,
  probe?: (signal: AbortSignal) => Promise<boolean>,
): NativeNotificationSession {
  const readiness = new NotificationReadinessState(ready, probe);
  return {
    get ready() {
      return readiness.ready;
    },
    refreshReadiness: (signal) => readiness.refresh(signal),
    handlers: () => ({
      desktop_notification: async (params, context) => {
        if (!readiness.ready)
          return failureResult({
            errorCode: "notification_setup_required",
            message:
              "Desktop notifications are unavailable. Update Computer access setup and check the operating system notification settings.",
          });
        try {
          const notification = readDesktopNotification(
            params,
            platform,
            runtimeUrl,
          );
          context?.abortSignal?.throwIfAborted();
          await renderer.send(notification, context?.abortSignal);
          return successResult({
            output:
              "Notification submitted to the desktop notification service.",
            data: {
              notificationId: notification.notificationId,
              delivery: "submitted",
            },
          });
        } catch (error) {
          return failureResult({
            errorCode: hasUnknownNotificationOutcome(error)
              ? "notification_outcome_unknown"
              : "notification_native_failed",
            message:
              error instanceof Error
                ? error.message.slice(0, 1000)
                : "Desktop notification submission failed.",
          });
        }
      },
    }),
    close: () => renderer.close(),
  };
}

export async function createNativeNotificationSession(
  platform: HostIdentity["os"],
  runtimeUrl: string,
  locations: NotificationLocations = defaultNotificationLocations(),
  signal?: AbortSignal,
): Promise<NativeNotificationSession> {
  signal?.throwIfAborted();
  const linux = new LinuxNotificationRenderer();
  const ready = await hasDesktopNotificationSupport(
    platform,
    locations,
    runNotificationProcess,
    signal,
  );
  signal?.throwIfAborted();
  const session = createNotificationSession(
    platform,
    runtimeUrl,
    ready,
    {
      async send(notification, signal) {
        if (platform === "windows")
          return sendWindowsNotification(notification, signal);
        if (platform === "macos")
          return sendMacNotification(notification, locations, signal);
        return linux.send(notification, signal);
      },
      async close() {
        linux.close();
        if (platform === "macos" && session.ready)
          await stopMacNotificationApp(locations, runNotificationProcess).catch(
            (error: unknown) => {
              console.warn(
                "Desktop notification helper could not stop: " +
                  (error instanceof Error ? error.message : String(error)),
              );
            },
          );
      },
    },
    (refreshSignal) =>
      hasDesktopNotificationSupport(
        platform,
        locations,
        runNotificationProcess,
        refreshSignal,
      ),
  );
  return session;
}
