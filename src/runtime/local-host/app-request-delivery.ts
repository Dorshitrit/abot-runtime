import type { LocalRuntimePeer } from "./contracts.js";

type DeliveryTarget = {
  peer: LocalRuntimePeer;
  connected: boolean;
  removeClose: () => void;
};

/** Replaces a live request subscriber without replaying execution or past events. */
export class LocalRequestDelivery {
  private target?: DeliveryTarget;
  private delivery = Promise.resolve();
  private settle!: () => void;
  readonly finished = new Promise<void>((resolve) => {
    this.settle = resolve;
  });

  constructor(private readonly requestId: string) {}

  attach(peer: LocalRuntimePeer): void {
    this.detach();
    const target: DeliveryTarget = {
      peer,
      connected: true,
      removeClose: () => {},
    };
    this.target = target;
    target.removeClose = peer.onClose(() => {
      target.connected = false;
    });
  }

  send(event: unknown): void {
    const target = this.target;
    if (!target?.connected) return;
    this.delivery = this.delivery
      .then(async () => {
        if (!this.isCurrentTarget(target)) return;
        await target.peer.callClient("request.event", [this.requestId, event]);
      })
      .catch(() => {
        target.connected = false;
      });
  }

  drain(): Promise<void> {
    return this.delivery;
  }

  finish(): void {
    this.detach();
    this.settle();
  }

  private isCurrentTarget(target: DeliveryTarget): boolean {
    if (this.target !== target) return false;
    return target.connected;
  }

  private detach(): void {
    const target = this.target;
    this.target = undefined;
    if (!target) return;
    target.connected = false;
    target.removeClose();
  }
}
