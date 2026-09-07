import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import type { LocalRuntimeCallHandler } from "./contracts.js";
import {
  decodeRpcFrame,
  encodeRpcFrame,
  type RpcFrame,
} from "./rpc-protocol.js";

type PendingRpcCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class LocalRuntimeRpcPeer {
  readonly id = randomUUID();
  private readonly pending = new Map<string, PendingRpcCall>();
  private readonly events = new Set<(event: unknown) => void>();
  private readonly closedListeners = new Set<() => void>();
  private handler: LocalRuntimeCallHandler = async () => {
    throw new Error("local_runtime_client_handler_unavailable");
  };
  private closed = false;

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (data, binary) => this.receive(data, binary));
    socket.on("close", () => this.disconnected());
    socket.on("error", () => this.disconnected());
  }

  setHandler(handler: LocalRuntimeCallHandler): void {
    this.handler = handler;
  }

  call(method: string, args: readonly unknown[] = []): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new Error("local_runtime_connection_lost"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ kind: "call", id, method, args });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.events.add(listener);
    return () => {
      this.events.delete(listener);
    };
  }

  onClose(listener: () => void): () => void {
    if (this.closed) {
      listener();
      return () => {};
    }
    this.closedListeners.add(listener);
    return () => {
      this.closedListeners.delete(listener);
    };
  }

  publish(value: unknown): void {
    if (this.closed) return;
    try {
      this.send({ kind: "event", value });
    } catch {
      this.close();
    }
  }

  close(): void {
    this.disconnected();
    this.socket.terminate();
  }

  private send(frame: RpcFrame): void {
    if (this.socket.readyState !== WebSocket.OPEN)
      throw new Error("local_runtime_connection_lost");
    this.socket.send(encodeRpcFrame(frame), { binary: true }, (error) => {
      if (error) this.close();
    });
  }

  private receive(raw: RawData, binary: boolean): void {
    if (this.closed) return;
    try {
      if (!binary) throw new Error("local_runtime_invalid_frame");
      const frame = decodeRpcFrame(toFrameBuffer(raw));
      if (frame.kind === "call") {
        void this.respond(frame);
        return;
      }
      if (frame.kind === "event") {
        for (const listener of this.events)
          invokeListener(() => listener(frame.value));
        return;
      }
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      if (frame.kind === "error") pending.reject(restoreRpcError(frame));
      else pending.resolve(frame.value);
    } catch {
      this.close();
    }
  }

  private async respond(
    frame: Extract<RpcFrame, { kind: "call" }>,
  ): Promise<void> {
    try {
      const value = await this.handler(frame.method, frame.args);
      if (!this.closed) this.send({ kind: "result", id: frame.id, value });
    } catch (error) {
      if (this.closed) return;
      try {
        this.send({
          kind: "error",
          id: frame.id,
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error ? { name: error.name } : {}),
          ...(hasRpcErrorCode(error) ? { code: error.code } : {}),
        });
      } catch {
        this.close();
      }
    }
  }

  private disconnected(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values())
      pending.reject(new Error("local_runtime_connection_lost"));
    this.pending.clear();
    this.events.clear();
    for (const listener of this.closedListeners) invokeListener(listener);
    this.closedListeners.clear();
  }
}

function toFrameBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function invokeListener(listener: () => void): void {
  try {
    listener();
  } catch {
    /* Observers cannot break another peer's RPC. */
  }
}

function hasRpcErrorCode(error: unknown): error is { code: string } {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return typeof error.code === "string";
}

function restoreRpcError(frame: Extract<RpcFrame, { kind: "error" }>): Error {
  const error = new Error(frame.message);
  if (frame.name !== undefined) error.name = frame.name;
  if (frame.code !== undefined) Object.assign(error, { code: frame.code });
  return error;
}
