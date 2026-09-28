import WebSocket from "ws";
import { nativeLoopbackSocketOptions } from "./native-loopback-lookup.js";
import { DESKTOP_NOTIFICATION_CAPABILITY } from "./notification-protocol.js";
import {
  createNativeNotificationSession,
  type NativeNotificationSession,
} from "./native-notifications.js";
import { COMPANION_RELEASE_VERSION } from "./release-version.js";
import { CompanionComputerSessions } from "../computer/companion-sessions.js";
import { COMPUTER_CAPABILITY } from "../computer/native-validation.js";
import {
  NativeObservationSession,
  type ObservationCollectorFactory,
} from "./native-observations.js";
import {
  OBSERVATION_CAPABILITY,
  OBSERVATION_WIRE_LIMIT,
} from "./observation-protocol.js";
import type {
  ToolImplementation,
  ToolImplementationOutput,
} from "../../plugin-sdk/index.js";
import { createSystemHandlers } from "../handlers.js";
import {
  resolveNativeRuntimeAddress,
  type NativeHostResolver,
} from "./native-address.js";
import {
  assertNativeOperationTarget,
  NativeOperationInputError,
  readNativeServerMessage,
} from "./native-messages.js";
import {
  HOST_PROTOCOL_VERSION,
  HOST_WIRE_MAX_BYTES,
  type HostIdentity,
  type HostServerMessage,
} from "./protocol.js";

export type NativeSessionOutcome =
  | "disconnected"
  | "authorization_rejected"
  | "protocol_rejected"
  | "stopped";
export type NativeSessionOptions = Readonly<{
  url: string;
  authorization: string;
  identity: HostIdentity;
  hostId?: string;
  signal: AbortSignal;
  onPaired(hostId: string, credential: string): Promise<void>;
  onReady(hostId: string): void | Promise<void>;
  resolveHost?: NativeHostResolver;
  handlers?: Record<string, ToolImplementation>;
  heartbeatMs?: number;
  operationLimit?: number;
  observationCollector?: ObservationCollectorFactory;
  notifications?: NativeNotificationSession;
}>;

function operationFailure(
  message: string,
  code: string,
): ToolImplementationOutput {
  return {
    ok: false,
    output: message,
    errorCode: code,
    producedNewInformation: false,
  };
}

function hasHeaderSafeAuthorization(value: string): boolean {
  if (value.length < 6 || value.length > 256) return false;
  return /^[A-Za-z0-9_-]+$/u.test(value);
}

/** One connection lifetime. Its pending actions are never retried or replayed. */
export async function connectNativeHost(
  options: NativeSessionOptions,
): Promise<NativeSessionOutcome> {
  if (!hasHeaderSafeAuthorization(options.authorization))
    throw new Error("Invalid host pairing credential.");
  options.signal.throwIfAborted();
  const endpoint = await resolveNativeRuntimeAddress(
    options.url,
    options.resolveHost,
  );
  options.signal.throwIfAborted();
  const computers = new CompanionComputerSessions(options.identity.os);
  const notifications =
    options.notifications ??
    (await createNativeNotificationSession(
      options.identity.os,
      options.url,
      undefined,
      options.signal,
    ));
  const ownedNotifications = options.notifications ? undefined : notifications;
  if (options.signal.aborted) {
    await ownedNotifications?.close();
    options.signal.throwIfAborted();
  }
  const handlers = options.handlers ?? {
    ...createSystemHandlers(),
    ...computers.handlers(),
    ...notifications.handlers(),
  };
  return new Promise((resolve) => {
    const socket = new WebSocket(endpoint.url, {
      headers: { Authorization: `Bearer ${options.authorization}` },
      followRedirects: false,
      handshakeTimeout: 10_000,
      maxPayload: HOST_WIRE_MAX_BYTES,
      perMessageDeflate: false,
      ...nativeLoopbackSocketOptions(endpoint),
    });
    const active = new Map<string, AbortController>();
    const seen = new Set<string>();
    const observations = new NativeObservationSession((message) => {
      if (socket.bufferedAmount > OBSERVATION_WIRE_LIMIT * 2) {
        observations.close();
        stop("disconnected");
        return;
      }
      send(message);
    }, options.observationCollector);
    let hostId = options.hostId;
    let ready = false;
    let advertisedNotificationReady = false;
    let stopped = false;
    let retiring = false;
    let outcome: NativeSessionOutcome = "disconnected";
    let incoming = Promise.resolve();
    let pendingInbound = 0;
    let awaitingPong = false;
    let retirement: ReturnType<typeof setTimeout> | undefined;
    const handshake = setTimeout(() => stop("protocol_rejected"), 12_000);
    const heartbeat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      refreshNotificationCapabilitiesWhenIdle();
      if (retiring) return;
      if (awaitingPong) {
        stop("disconnected");
        return;
      }
      awaitingPong = true;
      socket.ping();
    }, options.heartbeatMs ?? 15_000);
    function stop(reason: NativeSessionOutcome): void {
      if (stopped) return;
      stopped = true;
      outcome = reason;
      clearTimeout(handshake);
      clearInterval(heartbeat);
      if (retirement) clearTimeout(retirement);
      observations.close();
      void computers.close();
      if (!options.notifications) void notifications.close();
      for (const controller of active.values()) controller.abort();
      socket.terminate();
    }
    const abort = () => stop("stopped");
    options.signal.addEventListener("abort", abort, { once: true });
    function send(value: unknown): void {
      if (stopped || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(value));
    }
    function sendResult(id: string, result: ToolImplementationOutput): void {
      const envelope = { type: "result", id, result };
      if (Buffer.byteLength(JSON.stringify(envelope)) <= HOST_WIRE_MAX_BYTES) {
        send(envelope);
        return;
      }
      send({
        type: "result",
        id,
        result: operationFailure(
          "The native operation settled but its result exceeded the transport limit. Inspect the target before repeating an action.",
          "system_host_result_too_large",
        ),
      });
    }
    function retireConnection(id: string): void {
      retiring = true;
      retirement = setTimeout(() => stop("disconnected"), 1_000);
      socket.send(
        JSON.stringify({
          type: "result",
          id,
          result: operationFailure(
            "The host connection reached its operation limit. This operation was not dispatched; the companion is reconnecting for future work.",
            "system_host_connection_refresh",
          ),
        }),
        () => socket.close(1012, "operation_limit"),
      );
    }
    function canRefreshNotificationCapabilities(): boolean {
      if (!ready) return false;
      if (stopped) return false;
      if (retiring) return false;
      if (pendingInbound !== 0) return false;
      if (active.size !== 0) return false;
      if (computers.hasActiveSessions()) return false;
      if (advertisedNotificationReady) return false;
      return notifications.ready;
    }
    function refreshNotificationCapabilitiesWhenIdle(): void {
      if (!canRefreshNotificationCapabilities()) return;
      retiring = true;
      retirement = setTimeout(() => stop("disconnected"), 1_000);
      // A close frame follows already queued results; active operations finish first.
      socket.close(1012, "capabilities_changed");
    }
    function execute(
      message: Extract<HostServerMessage, { type: "execute" }>,
    ): void {
      if (!ready || message.hostId !== hostId)
        throw new Error("Unbound native operation.");
      if (seen.has(message.id))
        throw new Error("Repeated native operation identity.");
      if (seen.size >= (options.operationLimit ?? 4_096)) {
        retireConnection(message.id);
        return;
      }
      seen.add(message.id);
      if (active.size >= 4) {
        sendResult(
          message.id,
          operationFailure("The host companion is busy.", "system_host_busy"),
        );
        return;
      }
      try {
        assertNativeOperationTarget(message, options.identity.os);
      } catch (error) {
        if (!(error instanceof NativeOperationInputError)) throw error;
        sendResult(message.id, operationFailure(error.message, error.code));
        return;
      }
      const handler = handlers[message.operation];
      if (!handler) throw new Error("Native operation handler is unavailable.");
      const controller = new AbortController();
      active.set(message.id, controller);
      void Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return handler(message.params, { abortSignal: controller.signal });
        })
        .then(
          (result) => sendResult(message.id, result),
          () => {
            sendResult(
              message.id,
              operationFailure(
                "Native operation observation failed; inspect the target before retrying.",
                "system_host_native_failed",
              ),
            );
          },
        )
        .finally(() => {
          active.delete(message.id);
          refreshNotificationCapabilitiesWhenIdle();
        });
    }
    async function receive(text: string): Promise<void> {
      const message = readNativeServerMessage(text);
      // A pairing receipt already received on the socket must reach private storage
      // even if its server closes while the asynchronous write is still pending.
      if ((stopped || retiring) && message.type !== "paired") return;
      if (message.type === "paired") {
        if (hostId || ready)
          throw new Error("Unexpected native pairing response.");
        hostId = message.hostId;
        await options.onPaired(message.hostId, message.credential);
        return;
      }
      if (message.type === "ready") {
        if (ready || hostId !== message.hostId)
          throw new Error("Native readiness identity mismatch.");
        ready = true;
        clearTimeout(handshake);
        await options.onReady(message.hostId);
        return;
      }
      if (message.type === "cancel") {
        active.get(message.id)?.abort();
        return;
      }
      if (
        message.type === "observe_start" ||
        message.type === "observe_renew" ||
        message.type === "observe_stop"
      ) {
        if (!ready) throw new Error("Unbound native observation.");
        observations.receive(message);
        return;
      }
      if (message.type === "execute") execute(message);
    }
    socket.on("open", () => {
      advertisedNotificationReady = notifications.ready;
      send({
        type: "hello",
        version: HOST_PROTOCOL_VERSION,
        identity: options.identity,
        capabilities: [
          OBSERVATION_CAPABILITY,
          COMPUTER_CAPABILITY,
          ...(advertisedNotificationReady
            ? [DESKTOP_NOTIFICATION_CAPABILITY]
            : []),
        ],
        companionVersion: COMPANION_RELEASE_VERSION,
        ...(hostId ? { hostId } : {}),
      });
    });
    socket.on("message", (data, binary) => {
      if (binary) {
        stop("protocol_rejected");
        return;
      }
      pendingInbound++;
      incoming = incoming
        .then(() => receive(data.toString()))
        .catch(() => {
          outcome = "protocol_rejected";
          stop("protocol_rejected");
        })
        .finally(() => {
          pendingInbound--;
          refreshNotificationCapabilitiesWhenIdle();
        });
    });
    socket.on("pong", () => {
      awaitingPong = false;
    });
    socket.on("unexpected-response", (_request, response) => {
      const rejected =
        response.statusCode === 401 || response.statusCode === 403;
      response.destroy();
      stop(rejected ? "authorization_rejected" : "protocol_rejected");
    });
    socket.on("error", () => stop("disconnected"));
    socket.on("close", (code, reason) => {
      if (!stopped && code === 1008) {
        const revoked = ["host_disconnected", "host_revoked"].includes(
          reason.toString(),
        );
        outcome = revoked ? "authorization_rejected" : "protocol_rejected";
      }
      stop(outcome);
      options.signal.removeEventListener("abort", abort);
      void incoming.then(() => resolve(outcome));
    });
    if (options.signal.aborted) abort();
  });
}
