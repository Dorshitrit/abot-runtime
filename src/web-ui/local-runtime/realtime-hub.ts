import type WebSocket from "ws";

import type { JsonObject } from "./contracts.js";
import { NotificationPresence } from "../notifications/presence.js";

function isRealtimeClientOpen(client: WebSocket): boolean {
  return client.readyState === client.OPEN;
}

export class RealtimeClientHub {
  private readonly clients = new Set<WebSocket>();
  readonly presence = new NotificationPresence();

  constructor(private readonly observe?: (payload: JsonObject) => void) {}

  add(client: WebSocket): void {
    this.clients.add(client);
    const remove = () => this.remove(client);
    client.on("close", remove);
    client.on("error", remove);
  }

  broadcast(payload: JsonObject): void {
    this.pruneNonOpenClients();
    this.observe?.(payload);
    for (const client of this.clients) {
      try {
        this.send(client, payload);
      } catch {
        this.remove(client);
      }
    }
  }

  send(client: WebSocket, payload: JsonObject): void {
    if (!isRealtimeClientOpen(client)) return;
    client.send(JSON.stringify(payload));
  }

  updatePresence(client: WebSocket, payload: JsonObject): void {
    if (!this.canAcceptPresence(client)) {
      this.presence.remove(client);
      return;
    }
    this.presence.update(client, payload);
  }

  private canAcceptPresence(client: WebSocket): boolean {
    if (!this.clients.has(client)) return false;
    return isRealtimeClientOpen(client);
  }

  private pruneNonOpenClients(): void {
    for (const client of this.clients) {
      if (isRealtimeClientOpen(client)) continue;
      this.remove(client);
    }
  }

  private remove(client: WebSocket): void {
    this.clients.delete(client);
    this.presence.remove(client);
  }
}
