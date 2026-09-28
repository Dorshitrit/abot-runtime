import {
  createNativeNotificationSession,
  type NativeNotificationSession,
} from "./native-notifications.js";
import { defaultNotificationLocations } from "./notification-locations.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  connectNativeHost,
  type NativeSessionOptions,
  type NativeSessionOutcome,
} from "./native-session.js";
import {
  hasSameNativeConnection,
  NATIVE_STATUS_INTERVAL_MS,
  type NativeHostState,
} from "./native-state.js";
import type { HostIdentity } from "./protocol.js";

function isTransientNativeLookupError(error: unknown): boolean {
  if (error === null) return false;
  if (typeof error !== "object") return false;
  if (!("code" in error)) return false;
  if (error.code === "EAI_AGAIN") return true;
  return error.code === "ENOTFOUND";
}

export async function runNativeHostSupervisor(
  options: Readonly<{
    state: NativeHostState;
    identity: HostIdentity;
    signal: AbortSignal;
    connect?: (options: NativeSessionOptions) => Promise<NativeSessionOutcome>;
    reconnectDelayMs?: number;
    buildId?: string;
    notifications?: NativeNotificationSession;
  }>,
): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  let notifications: NativeNotificationSession | undefined;
  let statusHostId: string | undefined;
  let stopWatching: (() => void) | undefined;
  let maintenance: ReturnType<typeof setInterval> | undefined;
  let refreshing: Promise<unknown> | undefined;
  try {
    controller.signal.throwIfAborted();
    const initial = await options.state.read();
    if (!initial) return;
    statusHostId = initial.hostId;
    controller.signal.throwIfAborted();
    let checking = false;
    let checkQueued = false;
    let connected = false;
    const checkState = async (refreshStatus = false) => {
      if (controller.signal.aborted) return;
      if (checking) {
        checkQueued = true;
        return;
      }
      checking = true;
      try {
        const current = await options.state.read();
        if (!current || !hasSameNativeConnection(initial, current)) {
          stop();
          return;
        }
        if (refreshStatus)
          await options.state.setStatus(
            initial.hostId,
            connected,
            options.buildId,
          );
      } catch {
        stop();
      } finally {
        checking = false;
        if (checkQueued) {
          checkQueued = false;
          void checkState();
        }
      }
    };
    let reconnectDelay = options.reconnectDelayMs ?? 500;
    stopWatching = options.state.watch?.(() => {
      void checkState();
    });
    await checkState();
    controller.signal.throwIfAborted();
    notifications =
      options.notifications ??
      (await createNativeNotificationSession(
        options.identity.os,
        initial.url,
        {
          ...defaultNotificationLocations(),
          stateDir: options.state.directory,
          homeDir: options.identity.homeDir,
        },
        controller.signal,
      ));
    const notificationSession = notifications;
    const refreshNotifications = () => {
      if (controller.signal.aborted) return;
      if (notificationSession.ready) return;
      if (refreshing) return;
      if (!notificationSession.refreshReadiness) return;
      refreshing = notificationSession
        .refreshReadiness(controller.signal)
        .catch(() => undefined)
        .finally(() => {
          refreshing = undefined;
        });
    };
    maintenance = setInterval(() => {
      void checkState(true);
      refreshNotifications();
    }, NATIVE_STATUS_INTERVAL_MS);
    while (!controller.signal.aborted) {
      const outcome = await (options.connect ?? connectNativeHost)({
        url: initial.url,
        authorization: initial.credential,
        hostId: initial.hostId,
        identity: options.identity,
        signal: controller.signal,
        notifications: notificationSession,
        onPaired: async () => {
          throw new Error("A saved native connection cannot pair again.");
        },
        onReady: async () => {
          connected = true;
          reconnectDelay = options.reconnectDelayMs ?? 500;
          await options.state.setStatus(initial.hostId, true, options.buildId);
        },
      }).catch((error) => {
        if (controller.signal.aborted) return "stopped" as const;
        if (isTransientNativeLookupError(error)) return "disconnected" as const;
        throw error;
      });
      connected = false;
      await options.state.setStatus(initial.hostId, false, options.buildId);
      if (outcome === "authorization_rejected") {
        await options.state.remove(initial);
        return;
      }
      if (outcome === "protocol_rejected" || outcome === "stopped") return;
      // Submitted desktop click handlers stay with this paired companion lifetime.
      // Only transport reconnects; pending operations are never replayed.
      await delay(reconnectDelay, undefined, {
        signal: controller.signal,
      }).catch(() => {});
      reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearInterval(maintenance);
    stopWatching?.();
    stop();
    options.signal.removeEventListener("abort", stop);
    try {
      await refreshing;
      await notifications?.close();
    } finally {
      if (statusHostId)
        await options.state.setStatus(statusHostId, false, options.buildId);
    }
  }
}
