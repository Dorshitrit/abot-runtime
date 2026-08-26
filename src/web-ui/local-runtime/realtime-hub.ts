import type WebSocket from "ws";

import type { JsonObject } from "./contracts.js";

export class RealtimeClientHub {
  private readonly clients = new Set<WebSocket>();

  add(client: WebSocket): void {
    this.clients.add(client);
    const remove = () => this.clients.delete(client);
    client.on("close", remove);
    client.on("error", remove);
  }

  broadcast(payload: JsonObject): void {
    for (const client of this.clients) this.send(client, payload);
  }

  send(client: WebSocket, payload: JsonObject): void {
    if (client.readyState !== client.OPEN) return;
    client.send(JSON.stringify(payload));
  }
}
