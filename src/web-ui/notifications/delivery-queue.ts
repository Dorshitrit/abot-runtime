/** Serializes desktop notifications across environments sharing one companion. */
export class NotificationDeliveryQueue {
  private pending: Promise<void> = Promise.resolve();

  enqueue(deliver: () => Promise<void>): Promise<void> {
    const delivery = this.pending.then(deliver);
    this.pending = delivery.catch(() => undefined);
    return delivery;
  }

  flush(): Promise<void> {
    return this.pending;
  }
}
