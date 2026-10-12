import { createEventRefresh } from "../lib/event-refresh.js";
import { learningFailureCopy } from "../components/passive-learning/failure-copy.js";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function learningActionErrorMessage(error) {
  const message = errorMessage(error);
  const explanation = learningFailureCopy(message);
  return explanation.code ? explanation.message : message;
}

function hasLearningStatus(result) {
  return (
    result?.status?.preferences?.enabled === true ||
    result?.status?.preferences?.enabled === false
  );
}

export function createPassiveLearningController({
  client,
  getEnvironmentId,
  render,
  isVisible = () => document.visibilityState === "visible",
  isRuntimeReady = () => true,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const state = {
    status: null,
    hostConnection: null,
    hostConnectionKey: "",
    batches: [],
    candidates: [],
    candidateError: "",
    loadingCandidates: false,
    selectedBatch: null,
    selectedBatchId: "",
    models: [],
    statusError: "",
    batchError: "",
    detailError: "",
    modelsError: "",
    loadingStatus: false,
    loadingBatches: false,
    loadingDetail: false,
    saving: false,
    restartingCollection: false,
  };
  let environmentId = getEnvironmentId();
  let workspace = "";
  let revision = 0;
  let detailRevision = 0;
  let stale = true;
  let modelsStale = true;
  let environmentEpoch = 0;
  let runtimeReady = isRuntimeReady();

  const learningActive = () => workspace === "learning";
  const homeActive = () => workspace === "home";
  function canRefresh() {
    if (!isRuntimeReady()) return false;
    if (!learningActive() && !homeActive()) return false;
    return isVisible();
  }
  const snapshot = () => ({
    ...state,
    environmentId,
    learningActive: learningActive(),
    homeActive: homeActive(),
  });
  const publish = () => render(snapshot());
  function currentRead(readEnvironmentId, readRevision) {
    if (!isRuntimeReady()) return false;
    if (readRevision !== revision) return false;
    return readEnvironmentId === getEnvironmentId();
  }

  async function readCurrentState() {
    stale = false;
    const readEnvironmentId = getEnvironmentId();
    const readRevision = ++revision;
    const includeBatches = learningActive();
    const includeModels = includeBatches && modelsStale;
    const includeCandidates =
      includeBatches &&
      typeof client.listPassiveLearningCandidates === "function";
    state.loadingStatus = state.status === null;
    state.loadingBatches = includeBatches && state.batches.length === 0;
    state.loadingCandidates =
      includeCandidates && state.candidates.length === 0;
    publish();
    const [statusRead, batchRead, modelRead, candidateRead] =
      await Promise.allSettled([
        client.loadPassiveLearning(readEnvironmentId),
        includeBatches
          ? client.listPassiveLearningBatches(readEnvironmentId)
          : Promise.resolve(null),
        includeModels
          ? client.listModels(readEnvironmentId)
          : Promise.resolve(null),
        includeCandidates
          ? client.listPassiveLearningCandidates(readEnvironmentId)
          : Promise.resolve(null),
      ]);
    if (!currentRead(readEnvironmentId, readRevision)) return;
    if (includeCandidates) {
      if (
        candidateRead.status === "fulfilled" &&
        Array.isArray(candidateRead.value?.items)
      ) {
        state.candidates = candidateRead.value.items;
        state.candidateError = "";
      } else {
        state.candidateError =
          candidateRead.status === "rejected"
            ? errorMessage(candidateRead.reason)
            : "Candidates are unavailable.";
      }
    }
    let changedSelectedBatch = false;
    if (
      statusRead.status === "fulfilled" &&
      hasLearningStatus(statusRead.value)
    ) {
      state.status = statusRead.value.status;
      state.statusError = "";
    } else {
      state.statusError =
        statusRead.status === "rejected"
          ? errorMessage(statusRead.reason)
          : "Learning status is unavailable.";
    }
    if (includeBatches) {
      if (
        batchRead.status === "fulfilled" &&
        Array.isArray(batchRead.value?.items)
      ) {
        const selectedId = state.selectedBatchId;
        const previous = state.batches.find((batch) => batch.id === selectedId);
        const next = batchRead.value.items.find(
          (batch) => batch.id === selectedId,
        );
        const summaryKey = (batch) =>
          JSON.stringify([
            batch?.status,
            batch?.reason,
            batch?.completedAt,
            batch?.observationCount,
            batch?.recordIds,
            batch?.candidateIds,
          ]);
        changedSelectedBatch = Boolean(
          selectedId && next && summaryKey(previous) !== summaryKey(next),
        );
        if (selectedId && !next) void selectBatch("");
        state.batches = batchRead.value.items;
        state.batchError = "";
      } else {
        state.batchError =
          batchRead.status === "rejected"
            ? errorMessage(batchRead.reason)
            : "Recent batches are unavailable.";
      }
    }
    if (includeModels) {
      if (
        modelRead.status === "fulfilled" &&
        Array.isArray(modelRead.value?.profiles)
      ) {
        state.models = modelRead.value.profiles;
        state.modelsError = "";
        modelsStale = false;
      } else {
        state.modelsError =
          modelRead.status === "rejected"
            ? errorMessage(modelRead.reason)
            : "Model choices are unavailable.";
      }
    }
    const hostState = JSON.stringify([
      state.status?.deviceId,
      state.status?.state,
    ]);
    if (includeModels || state.hostConnectionKey !== hostState) {
      try {
        const host = await client.getSystemHostConnection?.();
        if (!currentRead(readEnvironmentId, readRevision)) return;
        state.hostConnection = host ?? null;
        state.hostConnectionKey = hostState;
      } catch {
        if (!currentRead(readEnvironmentId, readRevision)) return;
        state.hostConnection = null;
      }
    }
    state.loadingStatus = false;
    state.loadingBatches = false;
    state.loadingCandidates = false;
    publish();
    if (changedSelectedBatch) void selectBatch(state.selectedBatchId);
  }

  const eventRefresh = createEventRefresh({
    canRefresh,
    refresh: readCurrentState,
    setTimer,
    clearTimer,
  });

  function maybeRefresh() {
    if (!canRefresh() || !stale) return;
    void eventRefresh.run();
  }

  function markStale() {
    stale = true;
    maybeRefresh();
  }

  function resetEnvironment() {
    eventRefresh.cancel();
    runtimeReady = isRuntimeReady();
    revision += 1;
    detailRevision += 1;
    environmentEpoch += 1;
    environmentId = getEnvironmentId();
    Object.assign(state, {
      status: null,
      hostConnection: null,
      hostConnectionKey: "",
      batches: [],
      candidates: [],
      candidateError: "",
      loadingCandidates: false,
      selectedBatch: null,
      selectedBatchId: "",
      models: [],
      statusError: "",
      batchError: "",
      detailError: "",
      modelsError: "",
      loadingStatus: false,
      loadingBatches: false,
      loadingDetail: false,
      saving: false,
      restartingCollection: false,
    });
    stale = true;
    modelsStale = true;
    publish();
    maybeRefresh();
  }

  async function selectBatch(id) {
    if (!isRuntimeReady()) return;
    const readEnvironmentId = getEnvironmentId();
    const readRevision = ++detailRevision;
    function hasCurrentBatchRead() {
      if (!isRuntimeReady()) return false;
      if (readRevision !== detailRevision) return false;
      return readEnvironmentId === getEnvironmentId();
    }
    state.selectedBatchId = id;
    state.selectedBatch = null;
    state.detailError = "";
    state.loadingDetail = Boolean(id);
    publish();
    if (!id) return;
    try {
      const result = await client.loadPassiveLearningBatch(
        id,
        readEnvironmentId,
      );
      if (!hasCurrentBatchRead()) return;
      if (!result?.batch || result.batch.id !== id)
        throw new Error("Batch details are unavailable.");
      state.selectedBatch = result.batch;
    } catch (error) {
      if (!hasCurrentBatchRead()) return;
      state.detailError = errorMessage(error);
    } finally {
      if (hasCurrentBatchRead()) {
        state.loadingDetail = false;
        publish();
      }
    }
  }

  async function mutateLearningState(mutate, failureMessage) {
    if (!isRuntimeReady()) return;
    if (state.saving) return;
    const mutationEnvironmentId = getEnvironmentId();
    const epoch = environmentEpoch;
    function mutationCurrent() {
      if (!isRuntimeReady()) return false;
      if (epoch !== environmentEpoch) return false;
      return mutationEnvironmentId === getEnvironmentId();
    }
    state.saving = true;
    state.statusError = "";
    publish();
    try {
      const result = await mutate(mutationEnvironmentId);
      if (!mutationCurrent()) return;
      if (!hasLearningStatus(result)) throw new Error(failureMessage);
      state.status = result.status;
      markStale();
      return result.status;
    } catch (error) {
      if (mutationCurrent()) state.statusError = learningActionErrorMessage(error);
    } finally {
      if (mutationCurrent()) {
        state.saving = false;
        publish();
      }
    }
  }

  function canRestartCollection() {
    if (!isRuntimeReady()) return false;
    if (state.saving || state.loadingStatus) return false;
    if (state.restartingCollection) return false;
    if (environmentId !== getEnvironmentId()) return false;
    return typeof client.restartPassiveLearningCollection === "function";
  }

  async function restartCollection() {
    if (!canRestartCollection()) return;
    const epoch = environmentEpoch;
    const targetEnvironment = environmentId;
    state.restartingCollection = true;
    try {
      return await mutateLearningState(
        (id) => client.restartPassiveLearningCollection(id),
        "Collection restart was not confirmed.",
      );
    } finally {
      const hasCurrentRestart = epoch === environmentEpoch && targetEnvironment === getEnvironmentId();
      if (hasCurrentRestart) {
        state.restartingCollection = false;
        publish();
      }
    }
  }

  function runtimeAvailabilityChanged() {
    if (isRuntimeReady() === runtimeReady) return;
    resetEnvironment();
  }

  async function refreshCollectionAccess() {
    if (!isRuntimeReady()) return;
    const epoch = environmentEpoch;
    const environment = getEnvironmentId();
    function collectionReadIsCurrent() {
      if (!isRuntimeReady() || epoch !== environmentEpoch) return false;
      return environment === getEnvironmentId();
    }
    try {
      const host = await client.getSystemHostConnection();
      if (!collectionReadIsCurrent()) return;
      if (typeof host?.collectionConsent?.accepted !== "boolean")
        throw new Error("Collection acknowledgment status is unavailable. Refresh and try again.");
      state.hostConnection = host;
      publish();
      return host;
    } catch (error) {
      if (!collectionReadIsCurrent()) return;
      state.statusError = errorMessage(error);
      publish();
    }
  }

  async function acceptCollectionConsent() {
    if (!isRuntimeReady() || state.saving) return;
    const epoch = environmentEpoch;
    const environment = getEnvironmentId();
    function consentUpdateIsCurrent() {
      if (!isRuntimeReady() || epoch !== environmentEpoch) return false;
      return environment === getEnvironmentId();
    }
    state.saving = true;
    state.statusError = "";
    publish();
    try {
      const receipt = await client.acceptSystemHostCollectionConsent();
      if (!consentUpdateIsCurrent()) return;
      if (receipt?.collectionConsent?.accepted !== true)
        throw new Error("Collection acknowledgment was not confirmed.");
      const host = await refreshCollectionAccess();
      if (!consentUpdateIsCurrent()) return;
      if (host?.collectionConsent?.accepted !== true)
        throw new Error("Collection acknowledgment could not be verified. Refresh and try again.");
      return host;
    } catch (error) {
      if (consentUpdateIsCurrent()) state.statusError = errorMessage(error);
    } finally {
      if (consentUpdateIsCurrent()) {
        state.saving = false;
        publish();
      }
    }
  }

  return Object.freeze({
    snapshot,
    runtimeAvailabilityChanged,
    publish,
    restartCollection,
    acceptCollectionConsent,
    refreshCollectionAccess,
    configure: (preferences) =>
      mutateLearningState(
        (id) => client.configurePassiveLearning(preferences, id),
        "Learning configuration was not confirmed.",
      ),
    clearPending: () =>
      mutateLearningState(
        (id) => client.clearPassiveLearningPending(id),
        "Pending activity deletion was not confirmed.",
      ),
    selectBatch,
    refresh: () => {
      stale = true;
      modelsStale = true;
      return eventRefresh.run();
    },
    reconnect: () => {
      state.hostConnectionKey = "";
      markStale();
    },
    visibilityChanged: maybeRefresh,
    handleRealtime(message) {
      if (message?.type === "system-host.changed") {
        revision += 1;
        state.hostConnectionKey = "";
        stale = true;
        eventRefresh.schedule();
        return;
      }
      if (message?.type !== "learning.changed") return;
      if (message.environmentId !== getEnvironmentId()) return;
      stale = true;
      eventRefresh.schedule();
    },
    setWorkspace(nextWorkspace) {
      const wasLearningActive = learningActive();
      const wasHomeActive = homeActive();
      workspace = nextWorkspace;
      if (!wasLearningActive && learningActive()) modelsStale = true;
      if (
        (!wasLearningActive && learningActive()) ||
        (!wasHomeActive && homeActive())
      )
        stale = true;
      publish();
      maybeRefresh();
    },
    environmentChanged: resetEnvironment,
  });
}
