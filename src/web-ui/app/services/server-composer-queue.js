import { createSessionComposerQueue } from "../lib/session-composer-queue.js";

/** Reads use the latest server projection. Mutations are serialized by the server. */
export function createServerComposerQueue(storage) {
  const ownerId = createWindowIdentity();
  const view = () => createSessionComposerQueue({ storage: {
    getItem: () => storage.snapshot()?.queue || null,
    setItem() { throw new Error("Queue writes require server acknowledgement."); },
  } });
  const change = (scope, action, input = {}) =>
    storage.execute({ kind: "queue", scope, action, ownerId, ...input });
  return {
    list: (scope) => view().list(scope),
    peek: (scope) => view().peek(scope),
    getBlockedRelease: (scope) => view().getBlockedRelease(scope),
    claimBlockedRelease: (scope, releaseToken, options = {}) => change(scope, "claim", { releaseToken, takeover: options.takeover === true }),
    beginBlockedSend: (scope, releaseToken) => change(scope, "begin", { releaseToken }),
    markBlockedUncertain: (scope, releaseToken) => change(scope, "uncertain", { releaseToken }),
    enqueue: (scope, item) => change(scope, "enqueue", { item }),
    releaseForTerminal: (scope, requestId) => change(scope, "release", { requestId }),
    bindReleasedSuccess: (scope, releaseToken, requestId) => change(scope, "bind", { releaseToken, requestId }),
    rebindBlocked: (scope, requestId) => change(scope, "rebind", { requestId }),
    updateBlockedRelease: (scope, releaseToken, item) => change(scope, "update", { releaseToken, item }),
    refresh: () => storage.refresh(),
  };
}

function createWindowIdentity() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // getRandomValues is also available on HTTP LAN origins, unlike randomUUID.
  return [...globalThis.crypto.getRandomValues(new Uint32Array(4))].join("-");
}
