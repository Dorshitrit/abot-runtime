import { randomUUID } from "node:crypto";
import { ExecPluginError } from "./errors.js";
import type { ExecProcessSnapshot } from "./types.js";

/** One terminal observation may be presented until it is accepted or rejected. */
export class ExecTerminalDelivery {
  private claim?: string;
  private accepted = false;

  get isClaimed(): boolean {
    return this.claim !== undefined;
  }

  assertAvailable(): void {
    if (this.isClaimed) throw this.unavailable();
  }

  reserve(snapshot: ExecProcessSnapshot): ExecProcessSnapshot {
    if (snapshot.status !== "settled") return snapshot;
    this.assertAvailable();
    this.claim = randomUUID();
    return Object.freeze({ ...snapshot, deliveryId: this.claim });
  }

  assertOwner(snapshot: ExecProcessSnapshot): void {
    if (snapshot.status !== "settled") return;
    if (!this.claim || snapshot.deliveryId !== this.claim || this.accepted)
      throw this.unavailable();
  }

  accept(snapshot: ExecProcessSnapshot): void {
    if (snapshot.status !== "settled") return;
    this.assertOwner(snapshot);
    this.accepted = true;
  }

  reject(snapshot: ExecProcessSnapshot): void {
    if (this.accepted) return;
    if (snapshot.deliveryId !== this.claim) return;
    this.claim = undefined;
  }

  private unavailable(): ExecPluginError {
    return new ExecPluginError(
      "unknown_exec_process",
      "The terminal exec result is already claimed by another observation.",
    );
  }
}
