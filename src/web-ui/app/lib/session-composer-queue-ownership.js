/** Persisted ownership has no expiry: uncertain sends require a manual handoff. */
export function hasValidQueueOwnership(queue) {
  const owner = queue.blockedReleaseOwner;
  if (owner === undefined || owner === null) return true;
  if (queue.blockedByReleaseToken === null) return false;
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return false;
  if (typeof owner.id !== "string" || !owner.id || owner.id.length > 128) return false;
  return ["editing", "sending", "uncertain"].includes(owner.state);
}

export function canEditBlockedRelease(queue, ownerId) {
  if (!queue.blockedReleaseOwner) return true;
  if (queue.blockedReleaseOwner.id !== ownerId) return false;
  return queue.blockedReleaseOwner.state === "editing";
}

export function canUpdateBlockedRelease(queue, ownerId) {
  return canEditBlockedRelease(queue, ownerId);
}

export function canBindBlockedRelease(queue, ownerId) {
  if (!queue.blockedReleaseOwner) return true;
  if (queue.blockedReleaseOwner.id !== ownerId) return false;
  return ["sending", "uncertain"].includes(queue.blockedReleaseOwner.state);
}

export function createQueueOwnership({ ownerId, readStore, writeStore, getQueue, createToken, projectRelease }) {
  function claimBlockedRelease(scope, releaseToken, { takeover = false } = {}) {
    if (!ownerId) return projectRelease(getQueue(readStore(), scope));
    const store = readStore();
    const queue = getQueue(store, scope);
    if (!queue?.blockedReleaseItem || queue.blockedByReleaseToken !== releaseToken) return null;
    const owner = queue.blockedReleaseOwner;
    if (!takeover && owner && !canEditBlockedRelease(queue, ownerId)) return null;
    if (takeover || !owner) queue.blockedByReleaseToken = createToken();
    queue.blockedReleaseOwner = { id: ownerId, state: "editing" };
    writeStore(store);
    return projectRelease(queue);
  }

  function changeOwnedPhase(scope, releaseToken, from, to) {
    if (!ownerId) return true;
    const store = readStore();
    const queue = getQueue(store, scope);
    if (queue?.blockedByReleaseToken !== releaseToken) return false;
    if (queue.blockedReleaseOwner?.id !== ownerId) return false;
    if (queue.blockedReleaseOwner.state !== from) return false;
    queue.blockedReleaseOwner.state = to;
    writeStore(store);
    return true;
  }

  return {
    claimBlockedRelease,
    beginBlockedSend: (scope, token) => changeOwnedPhase(scope, token, "editing", "sending"),
    markBlockedUncertain: (scope, token) => changeOwnedPhase(scope, token, "sending", "uncertain"),
  };
}
