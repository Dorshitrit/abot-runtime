/** Accepted deletion survives storage failure; rejected lifecycle calls release intent. */
export class SchedulerSessionDeletionState {
  private readonly confirmed = new Set<string>();
  private readonly pending = new Map<string, Set<symbol>>();

  has(sessionId: string): boolean {
    if (this.confirmed.has(sessionId)) return true;
    return this.pending.has(sessionId);
  }

  add(sessionId: string): void {
    this.confirmed.add(sessionId);
  }

  reserveIntent(sessionId: string): () => void {
    const reservations = this.pending.get(sessionId) ?? new Set<symbol>();
    const intent = Symbol();
    reservations.add(intent);
    this.pending.set(sessionId, reservations);
    return () => {
      reservations.delete(intent);
      if (!this.canReleaseSessionIntents(sessionId, reservations)) return;
      this.pending.delete(sessionId);
    };
  }

  private canReleaseSessionIntents(
    sessionId: string,
    reservations: Set<symbol>,
  ): boolean {
    if (reservations.size > 0) return false;
    return this.pending.get(sessionId) === reservations;
  }
}
