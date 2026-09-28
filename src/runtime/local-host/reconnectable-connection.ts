import type {
  LocalRuntimeCallHandler,
  LocalRuntimeConnection,
  LocalRuntimeEndpoint,
} from "./contracts.js";
import type { LocalRuntimeRpcPeer } from "./rpc-peer.js";
import { connectToRuntimeOwner } from "./startup-connection.js";

/** A fresh explicit attachment retains the original owner's credentials and lease. */
export function createReconnectableRuntimeConnection(
  initialPeer: LocalRuntimeRpcPeer,
  endpoint: LocalRuntimeEndpoint,
  ownership: "owner" | "client",
  closeOwner?: () => Promise<void>,
  isOwnerIdle: () => boolean = () => false,
): LocalRuntimeConnection {
  let peer = initialPeer;
  let disconnected = false;
  let shutdown: Promise<void> | undefined;
  let connecting: Promise<boolean> | undefined;
  let handler: LocalRuntimeCallHandler | undefined;
  const listeners = new Set<(event: unknown) => void>();
  const closeListeners = new Set<() => void>();

  function bind(current: LocalRuntimeRpcPeer): void {
    if (handler) current.setHandler(handler);
    current.subscribe((event) => {
      for (const listener of listeners) safelyNotify(() => listener(event));
    });
    current.onClose(() => {
      if (current !== peer) return;
      disconnected = true;
      for (const listener of closeListeners) safelyNotify(listener);
    });
  }

  async function attachToOriginalOwner(): Promise<boolean> {
    const attached = await connectToRuntimeOwner(endpoint, Date.now() + 10_000);
    if (shutdown) {
      attached.close();
      throw new Error("local_runtime_stopped");
    }
    peer = attached;
    disconnected = false;
    bind(attached);
    return true;
  }

  function close(): Promise<void> {
    if (shutdown) return shutdown;
    // Owner shutdown must synchronously close intake before its first await.
    shutdown = closeOwner ? closeOwner() : Promise.resolve(peer.close());
    return shutdown;
  }

  bind(peer);
  return Object.freeze({
    ownership,
    isOwnerIdle: () => !shutdown && isOwnerIdle(),
    closeIfIdle: () => {
      if (ownership !== "owner") return Promise.resolve(false);
      if (shutdown) return shutdown.then(() => true);
      if (!isOwnerIdle()) return Promise.resolve(false);
      return close().then(() => true);
    },
    call: (method, args) => peer.call(method, args),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setClientHandler: (nextHandler) => {
      handler = nextHandler;
      peer.setHandler(nextHandler);
    },
    onClose: (listener) => {
      closeListeners.add(listener);
      if (disconnected) safelyNotify(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
    reconnect: () => {
      if (shutdown) return Promise.reject(new Error("local_runtime_stopped"));
      if (!disconnected) return Promise.resolve(false);
      connecting ??= attachToOriginalOwner().finally(() => {
        connecting = undefined;
      });
      return connecting;
    },
    close,
  });
}

function safelyNotify(listener: () => void): void {
  try {
    listener();
  } catch {
    // An observer cannot interfere with another client projection.
  }
}
