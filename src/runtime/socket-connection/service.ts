import type { AgentBridgeConnectionStatus } from "../../bridge/start-agent-bridge.js";
import { validateRuntimeBridgeConnection, type RuntimeBridgeConnection } from "../../bridge/runtime-connection.js";
import type { RuntimeConfig } from "../ports.js";
import { parseSocketConnectionBundle, socketConnectionPreview, socketRegistrationId } from "./bundle.js";
import type { SocketConnectionChange, SocketConnectionImport, SocketConnectionManagement, SocketConnectionStatus } from "./contracts.js";
import { createSocketConnectionStore, type ManagedConnection } from "./store.js";

export type SocketConnectionTransport = {
  start(connection: RuntimeBridgeConnection, preserveIdentity: boolean): void;
  pause(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): AgentBridgeConnectionStatus | undefined;
  fence(): (() => void) | undefined;
};

function sameConnection(a: RuntimeBridgeConnection | undefined, b: RuntimeBridgeConnection) {
  return a?.runtimeId === b.runtimeId && a.url === b.url && a.token === b.token;
}
const invalid = () => new Error("socket_connection_input_invalid");

function connectionState(configured: boolean, paused: boolean, live?: AgentBridgeConnectionStatus): SocketConnectionStatus["state"] {
  if (!configured) return "not_configured";
  if (paused) return "paused";
  if (!live) return "offline";
  if (live.registered) return "connected";
  if (live.connectionError === "socket_connection_rejected") return "offline";
  if (live.reconnectAttempt > 0 || live.nextReconnectAt) return "reconnecting";
  return "connecting";
}

export function createSocketConnectionService(config: RuntimeConfig, transport?: SocketConnectionTransport, initialLegacy?: RuntimeBridgeConnection) {
  const store = createSocketConnectionStore(config);
  let legacy = initialLegacy;
  let active: RuntimeBridgeConnection | undefined;
  let activeExact = false;
  let releaseClaim: (() => Promise<void>) | undefined;
  let diagnostic: string | null = null;
  let closed = false;
  let tail = Promise.resolve();
  let shutdown: Promise<void> | undefined;

  function serialize<T>(operation: () => Promise<T>) {
    const result = tail.then(() => {
      if (closed) throw new Error("local_runtime_owner_stopped");
      return operation();
    });
    tail = result.then(() => {}, () => {});
    return result;
  }
  async function release() {
    if (releaseClaim) { await releaseClaim(); releaseClaim = undefined; }
  }
  async function withdraw() {
    active = undefined;
    await transport?.pause();
    await release();
  }
  async function apply(record?: ManagedConnection) {
    const selected = record ? record.connection : legacy;
    const connection = record?.enabled === false ? null : selected;
    const exact = record?.format === "bundle";
    diagnostic = null;
    if (!transport) return;
    if (connection && sameConnection(active, connection) && exact === activeExact) return;
    await withdraw();
    if (!connection || closed) return;
    try {
      const wireIdentity = socketRegistrationId(connection, exact);
      releaseClaim = await store.claim({ ...connection, runtimeId: wireIdentity });
      if (closed) { await release(); return; }
      transport.start(connection, exact);
      active = connection;
      activeExact = exact;
    } catch (error) {
      await release();
      diagnostic = error instanceof Error && error.message === "socket_connection_binding_in_use" ?
        error.message : "socket_connection_activation_failed";
      throw new Error(diagnostic);
    }
  }

  function statusFor(record?: ManagedConnection): SocketConnectionStatus {
    const connection = record ? record.connection : legacy;
    const live = active && transport?.getStatus();
    const state = connectionState(Boolean(connection), record?.enabled === false, live);
    let source: SocketConnectionStatus["source"] = null;
    if (connection) source = record ? "managed" : "legacy";
    return { localEnvironmentId: config.runtimeId, revision: record?.revision ?? 0,
      remoteRuntimeId: connection ? socketRegistrationId(connection, record?.format === "bundle") : null, serverOrigin: connection ? new URL(connection.url).origin : null,
      source, state,
      lastRegisteredAt: live?.lastRegisteredAt ?? null, nextRetryAt: live?.nextReconnectAt ?? null, error: diagnostic ?? live?.connectionError ?? null };
  }
  async function change(input: SocketConnectionChange, build: (record?: ManagedConnection) => Pick<ManagedConnection, "enabled" | "connection" | "format">) {
    if (!input || !Number.isSafeInteger(input.expectedRevision)) throw invalid();
    let releaseFence: (() => void) | undefined;
    try {
      const record = await store.change(input.expectedRevision, previous => {
        const next = build(previous);
        if (active && (!next.enabled || !next.connection || activeExact !== (next.format === "bundle") || !sameConnection(active, next.connection)))
          releaseFence = transport?.fence();
        return next;
      });
      // A committed intent remains retryable after transport failure; credentials never leave this boundary.
      await apply(record).catch(() => { diagnostic ??= "socket_connection_activation_failed"; });
      return statusFor(record);
    } finally { releaseFence?.(); }
  }
  function configured(record?: ManagedConnection) {
    const connection = record ? record.connection : legacy;
    if (!connection) throw new Error("socket_connection_not_configured");
    return connection;
  }
  const management: SocketConnectionManagement = {
    status: () => serialize(async () => statusFor(await store.read())),
    preview: async bundle => socketConnectionPreview(config.runtimeId, parseSocketConnectionBundle(bundle)),
    import: input => serialize(async () => {
      if (!input || (input.confirmBinding !== undefined && typeof input.confirmBinding !== "boolean")) throw invalid();
      const connection = parseSocketConnectionBundle(input.bundle);
      if (connection.runtimeId !== config.runtimeId && input.confirmBinding !== true)
        throw new Error("socket_connection_binding_confirmation_required");
      return change(input, () => ({ connection, enabled: true, format: "bundle" }));
    }),
    pause: input => serialize(() => change(input, record => ({ connection: configured(record), enabled: false, format: record?.format ?? "legacy" }))),
    resume: input => serialize(() => change(input, record => ({ connection: configured(record), enabled: true, format: record?.format ?? "legacy" }))),
    forget: input => serialize(() => change(input, () => ({ connection: null, enabled: false, format: "bundle" }))),
  };

  return {
    management,
    recover: () => serialize(async () => { await apply(await store.read()); }),
    startLegacy: (value: unknown) => serialize(async () => {
      const requested = validateRuntimeBridgeConnection(value, config.runtimeId);
      const record = await store.read();
      if (record) { await apply(record); return; }
      if (active && !sameConnection(active, requested)) throw new Error("runtime_bridge_connection_conflict");
      legacy = requested;
      await apply();
    }),
    call(method: string, args: readonly unknown[]): Promise<unknown> {
      if (method === "socketConnection.status" && args.length === 0) return management.status();
      if (args.length !== 1) return Promise.reject(invalid());
      switch (method) {
        case "socketConnection.preview": return management.preview(args[0]);
        case "socketConnection.import": return management.import(args[0] as SocketConnectionImport);
        case "socketConnection.pause": return management.pause(args[0] as SocketConnectionChange);
        case "socketConnection.resume": return management.resume(args[0] as SocketConnectionChange);
        case "socketConnection.forget": return management.forget(args[0] as SocketConnectionChange);
        default: return Promise.reject(invalid());
      }
    },
    stop(): Promise<void> {
      if (shutdown) return shutdown;
      closed = true;
      active = undefined;
      const stopping = transport?.stop();
      shutdown = Promise.all([tail, stopping]).then(() => release());
      return shutdown;
    },
  };
}
