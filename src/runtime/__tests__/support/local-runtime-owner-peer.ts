import { vi } from "vitest";
import type { LocalRuntimePeer } from "../../local-host/contracts.js";

export function makeOwnerControlPeer(id: string) {
  const listeners = new Set<() => void>();
  let closed = false;
  const callClient = vi.fn<LocalRuntimePeer["callClient"]>(async () => ({
    approved: true,
  }));
  const peer: LocalRuntimePeer = {
    id,
    callClient,
    onClose(listener) {
      if (closed) listener();
      else listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    peer,
    callClient,
    close() {
      closed = true;
      for (const listener of listeners) listener();
      listeners.clear();
    },
  };
}
