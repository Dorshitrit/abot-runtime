import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  failureResult,
  type ToolImplementationOutput,
} from "../../../../src/plugin-sdk/index.js";
import { attachHostEvidence } from "../host-evidence.js";
import {
  hasMatchingHostIdentity,
  isHostIdentifier,
  isHostIdentity,
  isHostRecord,
  isHostToolResult,
  type HostOperation,
  type HostStatus,
} from "./protocol.js";
import { HostPairingStore } from "./pairing-store.js";
import { monitorHostLiveness } from "./liveness.js";

function unavailable(message: string) {
  return failureResult({ errorCode: "system_host_unavailable", message });
}
function uncertain() {
  return failureResult({
    errorCode: "system_host_outcome_unknown",
    message:
      "Host observation ended before a settled result. Effects or detached processes may remain. Inspect the same host before retrying; this operation was not replayed.",
    data: { outcome: "unknown", retrySafe: false },
  });
}
export class HostConnection {
  private client?: WebSocket;
  private connectionId?: string;
  private readonly sockets = new Set<WebSocket>();
  private readonly pending = new Map<
    string,
    { finish(result: ToolImplementationOutput): void }
  >();
  constructor(private readonly store: HostPairingStore) {}
  status(): HostStatus {
    const host = this.store.host();
    if (!host) return { paired: false, connected: false };
    const identity = {
      paired: true,
      hostId: host.hostId,
      identity: host.identity,
    };
    if (!this.connectionId) return { ...identity, connected: false };
    if (this.client?.readyState !== WebSocket.OPEN)
      return { ...identity, connected: false };
    return { ...identity, connected: true, connectionId: this.connectionId };
  }
  accept(client: WebSocket, token: string): void {
    this.sockets.add(client);
    monitorHostLiveness(client);
    let ready = false;
    const helloDeadline = setTimeout(
      () => client.close(1008, "hello_required"),
      5_000,
    );
    client.on("error", () => client.terminate());
    client.on("close", () => {
      clearTimeout(helloDeadline);
      this.sockets.delete(client);
      if (this.client !== client) return;
      this.client = undefined;
      this.connectionId = undefined;
      for (const operation of this.pending.values())
        operation.finish(uncertain());
    });
    client.on("message", (bytes, binary) => {
      try {
        if (binary) throw new Error("binary_not_supported");
        const message = JSON.parse(bytes.toString()) as unknown;
        if (!isHostRecord(message)) throw new Error("invalid_message");
        if (!ready) {
          ready = this.acceptHello(client, token, message);
          if (ready) clearTimeout(helloDeadline);
          return;
        }
        this.acceptResult(client, message);
      } catch {
        client.close(1008, "host_protocol_rejected");
      }
    });
  }
  private acceptHello(
    client: WebSocket,
    token: string,
    message: Record<string, unknown>,
  ): boolean {
    if (message.type !== "hello") throw new Error("hello_required");
    if (message.version !== 1) throw new Error("protocol_version_mismatch");
    if (!isHostIdentity(message.identity))
      throw new Error("host_identity_invalid");
    const authorization = this.store.authenticate(token);
    if (authorization === "pairing") {
      const grant = this.store.consume(token, message.identity);
      client.send(JSON.stringify({ type: "paired", ...grant }));
      client.close(1000, "reconnect_with_credential");
      return false;
    }
    if (authorization !== "credential") throw new Error("host_not_authorized");
    const host = this.store.host()!;
    if (message.hostId !== host.hostId)
      throw new Error("host_identity_mismatch");
    if (!hasMatchingHostIdentity(host.identity, message.identity))
      throw new Error("host_identity_mismatch");
    if (this.client) {
      client.close(1013, "host_connection_retiring");
      return false;
    }
    this.client = client;
    this.connectionId = randomUUID();
    client.send(JSON.stringify({ type: "ready", hostId: host.hostId }));
    return true;
  }
  private acceptResult(
    client: WebSocket,
    message: Record<string, unknown>,
  ): void {
    if (this.client !== client) throw new Error("host_connection_superseded");
    if (message.type !== "result") throw new Error("unexpected_message");
    if (!isHostIdentifier(message.id))
      throw new Error("operation_identity_invalid");
    if (!isHostToolResult(message.result))
      throw new Error("operation_result_invalid");
    this.pending.get(message.id)?.finish(message.result);
  }
  execute(input: {
    hostId: string;
    connectionId: string;
    operation: HostOperation;
    params: Record<string, unknown>;
    abortSignal?: AbortSignal;
  }): Promise<ToolImplementationOutput> {
    const host = this.store.host();
    if (!host) return Promise.resolve(unavailable("No computer is paired."));
    if (host.hostId !== input.hostId)
      return Promise.resolve(
        unavailable("The approved computer is not the paired computer."),
      );
    const client = this.client;
    if (client?.readyState !== WebSocket.OPEN)
      return Promise.resolve(
        unavailable("The paired computer is disconnected."),
      );
    if (this.connectionId !== input.connectionId)
      return Promise.resolve(
        unavailable("The approved host connection is no longer current."),
      );
    if (input.abortSignal?.aborted)
      return Promise.resolve(
        unavailable("Operation cancelled before host dispatch."),
      );
    if (this.pending.size >= 16)
      return Promise.resolve(
        unavailable(
          "The host connection is at its concurrent operation limit.",
        ),
      );
    const id = randomUUID();
    return new Promise((resolve) => {
      const finish = (result: ToolImplementationOutput) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(deadline);
        input.abortSignal?.removeEventListener("abort", cancel);
        resolve(attachHostEvidence(result, host.hostId, host.identity));
      };
      const cancel = () => {
        if (client.readyState === WebSocket.OPEN)
          client.send(JSON.stringify({ type: "cancel", id }));
        finish(uncertain());
      };
      const deadline = setTimeout(cancel, 610_000);
      this.pending.set(id, { finish });
      input.abortSignal?.addEventListener("abort", cancel, { once: true });
      client.send(
        JSON.stringify({
          type: "execute",
          id,
          hostId: host.hostId,
          operation: input.operation,
          params: input.params,
        }),
        (error) => {
          if (error) finish(uncertain());
        },
      );
    });
  }
  disconnect(): void {
    for (const operation of this.pending.values())
      operation.finish(uncertain());
    this.client = undefined;
    this.connectionId = undefined;
    for (const socket of this.sockets) socket.close(1008, "host_disconnected");
  }
  close(): void {
    for (const operation of this.pending.values())
      operation.finish(uncertain());
    this.client = undefined;
    this.connectionId = undefined;
    for (const socket of this.sockets) {
      socket.close(1012, "host_service_restarting");
      const deadline = setTimeout(() => socket.terminate(), 1000);
      deadline.unref();
      socket.once("close", () => clearTimeout(deadline));
    }
  }
}
