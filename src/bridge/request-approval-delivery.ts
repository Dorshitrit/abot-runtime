import type WebSocket from "ws";

type Binding = Readonly<{ sessionId: string; socket: WebSocket }>;
const MAX_APPROVAL_DELIVERY_BINDINGS = 512;

/** Connection-scoped event views, not approval authority or persisted ownership. */
export class BridgeApprovalDelivery {
  private readonly bindings = new Map<string, Binding>();
  private stopped = false;

  constructor(private readonly currentSocket: () => WebSocket | undefined) {}

  isCurrent(socket: WebSocket): boolean {
    if (this.stopped) return false;
    if (this.currentSocket() !== socket) return false;
    return socket.readyState === 1;
  }

  bind(socket: WebSocket, sessionId: string, requestId: string): () => void {
    if (!this.isCurrent(socket)) throw new Error("approval_connection_changed");
    const existing = this.bindings.get(requestId);
    if (existing && existing.sessionId !== sessionId)
      throw new Error("approval_scope_mismatch");
    if (!existing && this.bindings.size >= MAX_APPROVAL_DELIVERY_BINDINGS)
      throw new Error("approval_delivery_capacity");
    const binding = { sessionId, socket };
    this.bindings.set(requestId, binding);
    return () => {
      if (this.bindings.get(requestId) !== binding) return;
      if (existing && this.isCurrent(existing.socket)) {
        this.bindings.set(requestId, existing);
        return;
      }
      this.bindings.delete(requestId);
    };
  }

  has(socket: WebSocket, requestId: string): boolean {
    if (!this.isCurrent(socket)) return false;
    return this.bindings.get(requestId)?.socket === socket;
  }

  release(requestId: string): void {
    this.bindings.delete(requestId);
  }

  disconnect(socket: WebSocket): void {
    for (const [requestId, binding] of this.bindings)
      if (binding.socket === socket) this.bindings.delete(requestId);
  }

  stop(): void {
    this.stopped = true;
    this.bindings.clear();
  }

  requestSocket(sessionId: string, requestId: string): WebSocket {
    return {
      send: (data: string) => {
        const event: unknown = JSON.parse(data);
        if (!event || typeof event !== "object" || Array.isArray(event)) return;
        const payload = event as Record<string, unknown>;
        if (payload.requestId !== requestId) return;
        if (payload.sessionId !== undefined && payload.sessionId !== sessionId)
          return;
        this.publish({ ...payload, sessionId });
      },
    } as WebSocket;
  }

  publish(event: Record<string, unknown>): void {
    if (typeof event.requestId !== "string") return;
    const binding = this.bindings.get(event.requestId);
    if (!binding || binding.sessionId !== event.sessionId) return;
    if (!this.isCurrent(binding.socket)) return;
    this.send(binding.socket, event);
    if (event.type === "completed" || event.type === "failed")
      this.bindings.delete(event.requestId);
  }

  send(socket: WebSocket, payload: Record<string, unknown>): void {
    if (!this.isCurrent(socket)) return;
    // Transport failure never becomes an approval decision or a replayed run.
    try {
      socket.send(JSON.stringify(payload), () => {});
    } catch {}
  }
}
