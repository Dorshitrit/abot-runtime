import { setTimeout as delay } from "node:timers/promises";
import {
  connectNativeHost,
  type NativeSessionOptions,
  type NativeSessionOutcome,
} from "./native-session.js";
import {
  hasSameNativeConnection,
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
  }>,
): Promise<void> {
  const initial = await options.state.read();
  if (!initial) return;
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal.addEventListener("abort", stop, { once: true });
  let checking = false;
  let connected = false;
  const checkState = async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try {
      const current = await options.state.read();
      if (!current || !hasSameNativeConnection(initial, current)) {
        stop();
        return;
      }
      await options.state.setStatus(initial.hostId, connected);
    } catch {
      stop();
    } finally {
      checking = false;
    }
  };
  const poll = setInterval(() => {
    void checkState();
  }, 1_000);
  let reconnectDelay = options.reconnectDelayMs ?? 500;
  try {
    if (options.signal.aborted) stop();
    while (!controller.signal.aborted) {
      const outcome = await (options.connect ?? connectNativeHost)({
        url: initial.url,
        authorization: initial.credential,
        hostId: initial.hostId,
        identity: options.identity,
        signal: controller.signal,
        onPaired: async () => {
          throw new Error("A saved native connection cannot pair again.");
        },
        onReady: async () => {
          connected = true;
          reconnectDelay = options.reconnectDelayMs ?? 500;
          await options.state.setStatus(initial.hostId, true);
        },
      }).catch((error) => {
        if (controller.signal.aborted) return "stopped" as const;
        if (isTransientNativeLookupError(error)) return "disconnected" as const;
        throw error;
      });
      connected = false;
      await options.state.setStatus(initial.hostId, false);
      if (outcome === "authorization_rejected") {
        await options.state.remove(initial);
        return;
      }
      if (outcome === "protocol_rejected" || outcome === "stopped") return;
      // Only the connection is restored. No operation survives this boundary.
      await delay(reconnectDelay, undefined, {
        signal: controller.signal,
      }).catch(() => {});
      reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
    }
  } finally {
    clearInterval(poll);
    stop();
    options.signal.removeEventListener("abort", stop);
    await options.state.setStatus(initial.hostId, false);
  }
}
