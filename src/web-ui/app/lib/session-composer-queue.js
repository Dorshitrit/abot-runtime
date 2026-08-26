export const SESSION_COMPOSER_QUEUE_STORAGE_KEY =
  "abot-web.sessionComposerQueue.v1";

const STORAGE_VERSION = 1;
let fallbackReleaseTokenSequence = 0;

function emptyStore() {
  return { version: STORAGE_VERSION, queues: [] };
}

function isRecord(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype,
  );
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isJsonValue(value, depth = 0) {
  if (depth > 32) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1));
  }
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function isAttachmentRef(value) {
  return isRecord(value) && isJsonValue(value);
}

function isQueueItem(value) {
  return Boolean(
    isRecord(value) &&
    isNonEmptyString(value.waitForRequestId) &&
    typeof value.text === "string" &&
    Array.isArray(value.attachments) &&
    value.attachments.every(isAttachmentRef) &&
    isNonEmptyString(value.agentMode) &&
    isNonEmptyString(value.toolPermissionMode) &&
    (value.modelPreference === null ||
      (isRecord(value.modelPreference) && isJsonValue(value.modelPreference))),
  );
}

function isQueueRecord(value) {
  const blockedReleaseItem = value?.blockedReleaseItem ?? null;
  return Boolean(
    isRecord(value) &&
    isNonEmptyString(value.environmentId) &&
    isNonEmptyString(value.sessionId) &&
    (value.blockedByReleaseToken === null ||
      isNonEmptyString(value.blockedByReleaseToken)) &&
    (blockedReleaseItem === null || isQueueItem(blockedReleaseItem)) &&
    (value.blockedByReleaseToken !== null || blockedReleaseItem === null) &&
    Array.isArray(value.items) &&
    value.items.every(isQueueItem) &&
    (value.items.length > 0 || value.blockedByReleaseToken !== null),
  );
}

function isPersistedStore(value) {
  if (
    !isRecord(value) ||
    value.version !== STORAGE_VERSION ||
    !Array.isArray(value.queues) ||
    !value.queues.every(isQueueRecord)
  ) {
    return false;
  }
  const scopes = new Set();
  for (const queue of value.queues) {
    const scopeKey = JSON.stringify([queue.environmentId, queue.sessionId]);
    if (scopes.has(scopeKey)) return false;
    scopes.add(scopeKey);
  }
  return true;
}

function normalizePersistedStore(store) {
  for (const queue of store.queues) {
    if (queue.blockedReleaseItem === undefined) {
      queue.blockedReleaseItem = null;
    }
  }
  return store;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshotQueueItem(item) {
  const snapshot = {
    waitForRequestId: item?.waitForRequestId,
    text: item?.text,
    attachments: item?.attachments,
    agentMode: item?.agentMode,
    toolPermissionMode: item?.toolPermissionMode,
    modelPreference: item?.modelPreference ?? null,
  };
  if (!isQueueItem(snapshot)) {
    throw new TypeError("Invalid session composer queue item");
  }
  return cloneJson(snapshot);
}

function validateScope(scope) {
  if (
    !isRecord(scope) ||
    !isNonEmptyString(scope.environmentId) ||
    !isNonEmptyString(scope.sessionId)
  ) {
    throw new TypeError("Queue scope requires environmentId and sessionId");
  }
  return {
    environmentId: scope.environmentId,
    sessionId: scope.sessionId,
  };
}

function findQueue(store, scope) {
  return store.queues.find(
    (queue) =>
      queue.environmentId === scope.environmentId &&
      queue.sessionId === scope.sessionId,
  );
}

function createReleaseToken() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  fallbackReleaseTokenSequence += 1;
  return `release-${Date.now().toString(36)}-${fallbackReleaseTokenSequence.toString(36)}`;
}

export function createSessionComposerQueue({
  storage = globalThis.localStorage,
  storageKey = SESSION_COMPOSER_QUEUE_STORAGE_KEY,
} = {}) {
  if (
    !storage ||
    typeof storage.getItem !== "function" ||
    typeof storage.setItem !== "function"
  ) {
    throw new TypeError("Queue storage requires getItem and setItem");
  }
  if (!isNonEmptyString(storageKey)) {
    throw new TypeError("Queue storageKey must be a non-empty string");
  }

  function readStore() {
    try {
      const raw = storage.getItem(storageKey);
      if (raw === null) return emptyStore();
      if (typeof raw !== "string") return emptyStore();
      const parsed = JSON.parse(raw);
      return isPersistedStore(parsed)
        ? normalizePersistedStore(parsed)
        : emptyStore();
    } catch {
      return emptyStore();
    }
  }

  function writeStore(store) {
    storage.setItem(storageKey, JSON.stringify(store));
  }

  function enqueue(scopeInput, itemInput) {
    const scope = validateScope(scopeInput);
    const item = snapshotQueueItem(itemInput);
    const store = readStore();
    let queue = findQueue(store, scope);
    if (!queue) {
      queue = {
        ...scope,
        blockedByReleaseToken: null,
        blockedReleaseItem: null,
        items: [],
      };
      store.queues.push(queue);
    }
    queue.items.push(item);
    writeStore(store);
    return cloneJson(item);
  }

  function list(scopeInput) {
    const scope = validateScope(scopeInput);
    const queue = findQueue(readStore(), scope);
    return queue ? cloneJson(queue.items) : [];
  }

  function peek(scopeInput) {
    return list(scopeInput)[0] ?? null;
  }

  function getBlockedRelease(scopeInput) {
    const scope = validateScope(scopeInput);
    const queue = findQueue(readStore(), scope);
    if (
      !queue ||
      queue.blockedByReleaseToken === null ||
      queue.blockedReleaseItem === null
    ) {
      return null;
    }
    return {
      releaseToken: queue.blockedByReleaseToken,
      item: cloneJson(queue.blockedReleaseItem),
    };
  }

  function updateBlockedRelease(scopeInput, releaseToken, itemInput) {
    const scope = validateScope(scopeInput);
    if (!isNonEmptyString(releaseToken)) return false;
    const item = snapshotQueueItem(itemInput);
    const store = readStore();
    const queue = findQueue(store, scope);
    if (
      !queue ||
      queue.blockedByReleaseToken !== releaseToken ||
      queue.blockedReleaseItem === null
    ) {
      return false;
    }
    queue.blockedReleaseItem = item;
    writeStore(store);
    return true;
  }

  function releaseForTerminal(scopeInput, terminalRequestId) {
    const scope = validateScope(scopeInput);
    if (!isNonEmptyString(terminalRequestId)) return null;
    const store = readStore();
    const queue = findQueue(store, scope);
    if (
      !queue ||
      queue.blockedByReleaseToken !== null ||
      queue.items[0]?.waitForRequestId !== terminalRequestId
    ) {
      return null;
    }

    const [item] = queue.items.splice(0, 1);
    const releaseToken = createReleaseToken();
    queue.blockedByReleaseToken = releaseToken;
    queue.blockedReleaseItem = item;
    writeStore(store);
    return { item: cloneJson(item), releaseToken };
  }

  function bindReleasedSuccess(scopeInput, releaseToken, newRequestId) {
    const scope = validateScope(scopeInput);
    if (!isNonEmptyString(releaseToken) || !isNonEmptyString(newRequestId)) {
      return false;
    }
    const store = readStore();
    const queue = findQueue(store, scope);
    if (!queue || queue.blockedByReleaseToken !== releaseToken) return false;

    if (queue.items[0]) {
      queue.items[0].waitForRequestId = newRequestId;
    }
    queue.blockedByReleaseToken = null;
    queue.blockedReleaseItem = null;
    if (queue.items.length === 0) {
      store.queues = store.queues.filter((candidate) => candidate !== queue);
    }
    writeStore(store);
    return true;
  }

  function rebindBlocked(scopeInput, newRequestId) {
    const scope = validateScope(scopeInput);
    if (!isNonEmptyString(newRequestId)) return false;
    const store = readStore();
    const queue = findQueue(store, scope);
    if (!queue || queue.blockedByReleaseToken === null) return false;

    if (queue.items[0]) {
      queue.items[0].waitForRequestId = newRequestId;
    }
    queue.blockedByReleaseToken = null;
    queue.blockedReleaseItem = null;
    if (queue.items.length === 0) {
      store.queues = store.queues.filter((candidate) => candidate !== queue);
    }
    writeStore(store);
    return true;
  }

  return {
    enqueue,
    list,
    peek,
    getBlockedRelease,
    updateBlockedRelease,
    releaseForTerminal,
    bindReleasedSuccess,
    rebindBlocked,
  };
}
