type ConversationPresence = {
  environmentId: string;
  kind: "chat" | "agent";
  id: string;
  expiresAt: number;
};

function isPresenceIdentity(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value.trim() || value.length > 512) return false;
  return !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Browser attention is a short lease, never durable session read state. */
export class NotificationPresence {
  private readonly clients = new Map<object, ConversationPresence>();

  constructor(private readonly now: () => number = Date.now) {}

  update(client: object, message: Record<string, unknown>): void {
    this.clients.delete(client);
    if (message.active !== true) return;
    if (!isPresenceIdentity(message.environment)) return;
    const agent = message.agentId !== undefined;
    const id = agent ? message.agentId : message.sessionId;
    if (!isPresenceIdentity(id) || (agent && message.sessionId)) return;
    this.clients.set(client, {
      environmentId: message.environment,
      kind: agent ? "agent" : "chat", id,
      expiresAt: this.now() + 60_000,
    });
  }

  remove(client: object): void {
    this.clients.delete(client);
  }

  isViewing(environmentId: string, sessionId: string): boolean {
    return this.viewing(environmentId, "chat", sessionId);
  }

  isViewingAgent(environmentId: string, agentId: string): boolean {
    return this.viewing(environmentId, "agent", agentId);
  }

  private viewing(environmentId: string, kind: ConversationPresence["kind"], id: string): boolean {
    const now = this.now();
    for (const [client, presence] of this.clients) {
      if (presence.expiresAt <= now) {
        this.clients.delete(client);
        continue;
      }
      if (presence.environmentId !== environmentId) continue;
      if (presence.kind === kind && presence.id === id) return true;
    }
    return false;
  }
}
