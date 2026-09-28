import {
  executeHostOperation,
  readHostStatus,
} from "../../computer-access/companion/broker-client.js";
import { DESKTOP_NOTIFICATION_CAPABILITY } from "../../computer-access/companion/notification-protocol.js";
import type { HostStatus } from "../../computer-access/companion/protocol.js";
import type {
  NotificationDelivery,
  NotificationDesktopState,
  WebNotification,
} from "./contracts.js";

export type NotificationHostPort = {
  status: typeof readHostStatus;
  execute: typeof executeHostOperation;
};

function hasConnectedNotificationTarget(
  status: HostStatus,
): status is HostStatus & {
  connected: true;
  hostId: string;
  connectionId: string;
  identity: NonNullable<HostStatus["identity"]>;
} {
  if (!status.connected) return false;
  if (!status.hostId) return false;
  if (!status.connectionId) return false;
  return status.identity !== undefined;
}

function desktopAvailability(status: HostStatus): NotificationDesktopState {
  if (!status.paired)
    return {
      available: false,
      message:
        "Set up Computer access to receive notifications on this computer.",
    };
  if (!status.connected)
    return {
      available: false,
      message:
        "Computer access is disconnected. Notifications remain in your history.",
    };
  if (!status.capabilities?.includes(DESKTOP_NOTIFICATION_CAPABILITY))
    return {
      available: false,
      computerName: status.identity?.name,
      message: status.companion?.updateAvailable
        ? "Update Computer access to enable desktop notifications."
        : "Complete desktop notification setup in Computer access on this computer.",
    };
  return { available: true, computerName: status.identity?.name };
}

/** Dispatch once to the observed paired host; an uncertain result is not retried. */
export class DesktopNotificationDelivery {
  constructor(
    private readonly rootDir: string,
    private readonly host: NotificationHostPort = {
      status: readHostStatus,
      execute: executeHostOperation,
    },
  ) {}

  async status(): Promise<NotificationDesktopState> {
    try {
      return desktopAvailability(await this.host.status(this.rootDir));
    } catch {
      return {
        available: false,
        message:
          "Computer access status is unavailable. Notifications remain in your history.",
      };
    }
  }

  async send(
    item: WebNotification,
    signal: AbortSignal,
  ): Promise<NotificationDelivery> {
    let status: HostStatus;
    try {
      status = await this.host.status(this.rootDir);
    } catch {
      return {
        status: "unavailable",
        error: "Computer access status is unavailable.",
      };
    }
    const availability = desktopAvailability(status);
    if (!availability.available)
      return { status: "unavailable", error: availability.message };
    if (!hasConnectedNotificationTarget(status))
      return {
        status: "unavailable",
        error: "Computer access is unavailable.",
      };
    if (signal.aborted)
      return { status: "unavailable", error: "ABot is stopping." };
    const result = await this.host.execute(this.rootDir, {
      hostId: status.hostId,
      connectionId: status.connectionId,
      operation: "desktop_notification",
      params: {
        target: status.identity.os,
        notificationId: item.id,
        title: item.title,
        body: [...item.body].slice(0, 240).join(""),
        url: item.sourceUrl,
      },
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (result.ok) return { status: "submitted" };
    if (
      result.errorCode === "system_host_outcome_unknown" ||
      result.errorCode === "notification_outcome_unknown"
    )
      return {
        status: "unknown",
        error:
          "The computer did not confirm the result. This notification was not sent again.",
      };
    if (result.errorCode === "system_host_unavailable")
      return {
        status: "unavailable",
        error: "Computer access disconnected before delivery.",
      };
    const hasNativeErrorText = typeof result.error === "string";
    const nativeErrorText = hasNativeErrorText ? result.error : "";
    const error =
      nativeErrorText?.slice(0, 500) ||
      result.output?.slice(0, 500) ||
      "The computer could not submit the notification.";
    return { status: "failed", error };
  }
}
