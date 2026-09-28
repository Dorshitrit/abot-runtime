type ConversationPresence = {
  environmentId: string;
  sessionId: string;
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
    if (!isPresenceIdentity(message.sessionId)) return;
    this.clients.set(client, {
      environmentId: message.environment,
      sessionId: message.sessionId,
      expiresAt: this.now() + 60_000,
    });
  }

  remove(client: object): void {
    this.clients.delete(client);
  }

  isViewing(environmentId: string, sessionId: string): boolean {
    const now = this.now();
    for (const [client, presence] of this.clients) {
      if (presence.expiresAt <= now) {
        this.clients.delete(client);
        continue;
      }
      if (presence.environmentId !== environmentId) continue;
      if (presence.sessionId === sessionId) return true;
    }
    return false;
  }
}
