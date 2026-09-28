/** Readiness only advances to available; unavailable probes never overlap. */
export class NotificationReadinessState {
  private checking: Promise<boolean> | undefined;

  constructor(
    private available: boolean,
    private readonly probe?: (signal: AbortSignal) => Promise<boolean>,
  ) {}

  get ready(): boolean {
    return this.available;
  }

  async refresh(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (this.available) return true;
    if (!this.probe) return false;
    if (this.checking) return this.checking;
    this.checking = this.probe(signal)
      .then((ready) => {
        signal.throwIfAborted();
        this.available = ready;
        return ready;
      })
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }
}
