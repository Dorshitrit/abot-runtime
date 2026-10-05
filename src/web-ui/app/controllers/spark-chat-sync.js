import { normalizeConversationMessage } from "./conversation-session-controller.js";
import { rememberRequestLifecycle, sameConversationMessage } from "../lib/request-lifecycle-view.js";

export function mergeSparkSnapshotMessages(snapshot, current) {
  const canonical = (snapshot.messages || []).map(normalizeConversationMessage);
  const activeRequestIds = new Set((snapshot.requests || []).filter((request) => request.status === "streaming").map((request) => request.requestId));
  const unsettled = current.filter((message) => {
    if (!message.streaming) return false;
    if (activeRequestIds.has(message.requestId)) return true;
    return !canonical.some((entry) => sameConversationMessage(message, entry));
  });
  return [...canonical, ...unsettled];
}

function needsRequestLifecycleHydration(snapshot, state) {
  const requests = snapshot.requests || [];
  const unknownActive = requests.some((request) => request.status === "streaming" && request.requestId !== state.activeRequestId);
  if (unknownActive) return true;
  const current = requests.find((request) => request.requestId === state.activeRequestId);
  if (current && current.status !== "streaming") return true;
  return requests.some((request) => request.lifecycle?.status === "awaiting_approval"
    && !state.requestLifecycles.has(request.requestId));
}
function shouldHydrateSparkConversation(initialized, rehydrate, snapshot, state) {
  if (!initialized) return true;
  if (rehydrate) return true;
  return needsRequestLifecycleHydration(snapshot, state);
}
function hasReadableGeneration(readState) {
  if (readState?.readStateStatus === "unavailable") return false;
  return typeof readState?.readGeneration === "string";
}
function hasComposerAdvancedSinceRead(state, requestId) {
  if (state.composerSending) return true;
  return state.activeRequestId !== requestId;
}

/** Reconcile durable snapshots without changing drafts or replaying model requests. */
export function createSparkChatSync({
  client, getEnvironmentId, conversation, onConfiguration, onReadState, onSnapshot,
  onError, isAvailable,
  onHistoryReset = () => {},
}) {
  let loading = false;
  let queued = false;
  let initialized = false;
  let revision = 0;
  let consolidateNext = true;
  let pendingWaiters = [];
  let modelProfiles = [];
  let modelCatalogEnvironment = "";
  let readGeneration;
  let rehydrateNext = false;
  let hydrating = false;
  const state = conversation.state;

  function canRefresh() {
    if (!isAvailable()) return false;
    if (!getEnvironmentId()) return false;
    if (state.composerSending) return false;
    return !loading;
  }
  function isCurrentRead(environmentId, readRevision) {
    if (environmentId !== getEnvironmentId()) return false;
    return readRevision === revision;
  }
  async function drain() {
    if (!canRefresh()) return;
    queued = false;
    loading = true;
    const environmentId = getEnvironmentId();
    const readRevision = revision;
    const requestAtReadStart = state.activeRequestId;
    const rehydrate = rehydrateNext;
    rehydrateNext = false;
    const waiters = pendingWaiters;
    pendingWaiters = [];
    try {
      const result = await client.loadSparkChat(environmentId);
      if (!isCurrentRead(environmentId, readRevision)) return;
      if (modelCatalogEnvironment !== environmentId || !modelProfiles.some((profile) => profile.id === result.modelProfileId)) {
        const catalog = await client.listModels(environmentId);
        if (!isCurrentRead(environmentId, readRevision)) return;
        modelProfiles = catalog.profiles || catalog.models || [];
        modelCatalogEnvironment = environmentId;
      }
      const profile = modelProfiles.find((item) => item.id === result.modelProfileId);
      if (hasComposerAdvancedSinceRead(state, requestAtReadStart)) {
        queued = true; pendingWaiters.push(...waiters.splice(0)); return;
      }
      const supportsImageInput = profile?.supportsImageInput === true || profile?.capabilities?.inputModalities?.includes("image") === true;
      if (hasReadableGeneration(result.readState) && readGeneration !== undefined && readGeneration !== result.readState.readGeneration) {
        initialized = false;
        onHistoryReset();
      }
      if (hasReadableGeneration(result.readState)) readGeneration = result.readState.readGeneration;
      onConfiguration({ ...result, supportsImageInput, modelAvailable: Boolean(profile) });
      onReadState(result.readState);
      const snapshot = result.snapshot;
      if (shouldHydrateSparkConversation(initialized, rehydrate, snapshot, state)) {
        initialized = false; hydrating = true;
        await conversation.session.openSession(result.sessionId);
        hydrating = false;
        if (!isCurrentRead(environmentId, readRevision)) return;
        initialized = true;
      } else {
        state.messages = mergeSparkSnapshotMessages(snapshot, state.messages);
        for (const request of snapshot.requests || []) rememberRequestLifecycle(state, request.lifecycle);
        for (const message of state.messages) {
          if (message.role !== "assistant" || !message.requestId) continue;
          state.requestMessages.set(message.requestId, message.id);
        }
        conversation.render();
      }
      onSnapshot(snapshot, result.readState, { consolidated: consolidateNext });
      consolidateNext = false;
      conversation.update();
      waiters.forEach((waiter) => waiter.resolve(result));
    } catch (error) {
      if (isCurrentRead(environmentId, readRevision)) onError(error);
      waiters.forEach((waiter) => waiter.reject(error));
    } finally {
      hydrating = false;
      waiters.forEach((waiter) => waiter.resolve(undefined));
      loading = false;
      if (queued) void drain();
    }
  }
  function refresh({ consolidated = false, wait = false, rehydrate = false } = {}) {
    if (!isAvailable() || !getEnvironmentId()) return Promise.resolve(undefined);
    queued = true;
    consolidateNext ||= consolidated;
    rehydrateNext ||= rehydrate;
    const promise = wait ? new Promise((resolve, reject) => pendingWaiters.push({ resolve, reject })) : Promise.resolve();
    void drain();
    return promise;
  }
  return {
    refresh,
    isReady: () => initialized && !hydrating,
    composerChanged(sending) { if (!sending && queued) void drain(); },
    reset() {
      revision += 1; initialized = false; queued = false; consolidateNext = true;
      modelCatalogEnvironment = ""; modelProfiles = [];
      readGeneration = undefined;
      rehydrateNext = false;
      pendingWaiters.forEach((waiter) => waiter.resolve(undefined)); pendingWaiters = [];
    },
    modelChanged() { modelCatalogEnvironment = ""; void refresh(); },
  };
}
