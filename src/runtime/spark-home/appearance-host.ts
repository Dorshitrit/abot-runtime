import type { LocalRuntimePeer } from "../local-host/contracts.js";
import { captureSparkHomeAppearanceReference, type SparkHomeAppearanceReference } from "./appearance-reference.js";

/** HOME-only optional decoration supplied by a connected presentation host. */
export class SparkHomeAppearanceHost {
  private readonly peers = new Map<string, LocalRuntimePeer>();

  register(peer: LocalRuntimePeer): void {
    this.peers.set(peer.id, peer);
    peer.onClose(() => { if (this.peers.get(peer.id) === peer) this.peers.delete(peer.id); });
  }

  async read(): Promise<SparkHomeAppearanceReference | undefined> {
    const peer = [...this.peers.values()].at(-1);
    if (!peer) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        peer.callClient("sparkHome.appearance", []),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1000); }),
      ]);
      return captureSparkHomeAppearanceReference(value);
    } catch {
      return undefined;
    } finally { if (timer) clearTimeout(timer); }
  }
}
