import {
  canManageSchedule,
  matchesScheduleFilter,
  scheduleErrorMessage,
} from "../lib/schedule-presentation.js";

export function createSchedulesController({
  client,
  getEnvironmentId,
  render,
  openConversation,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const state = {
    environmentId: "",
    jobs: [],
    sessions: [],
    models: [],
    defaultModelProfileId: "",
    selectedId: "",
    runs: [],
    runsCursor: null,
    runsNextCursor: null,
    runsPreviousCursors: [],
    query: "",
    filter: "current",
    loading: false,
    loadingRuns: false,
    mutation: "",
    error: "",
    detailError: "",
    editor: null,
  };
  let active = false;
  let loadRevision = 0;
  let detailRevision = 0;
  let selectionRevision = 0;
  let pendingDetailRead = null;
  let pollTimer;
  const publish = () => render({ ...state });
  const isCurrentEnvironment = (environmentId) =>
    environmentId === getEnvironmentId();
  const hasCurrentListRead = (revision, environmentId) =>
    revision === loadRevision && isCurrentEnvironment(environmentId);
  const hasCurrentDetailRead = (revision, environmentId, jobId) =>
    revision === detailRevision &&
    isCurrentEnvironment(environmentId) &&
    state.selectedId === jobId;

  function resetRunPages() {
    Object.assign(state, {
      runs: [],
      runsCursor: null,
      runsNextCursor: null,
      runsPreviousCursors: [],
    });
  }

  function selectJobIdentity(jobId) {
    if (state.selectedId !== jobId) resetRunPages();
    state.selectedId = jobId;
  }

  function isVisibleJob(job) {
    return matchesScheduleFilter(
      job,
      state.query,
      state.filter,
      state.sessions,
    );
  }

  function firstVisibleJob() {
    return state.jobs.find(isVisibleJob);
  }

  function hasLoadedJob(jobId) {
    return state.jobs.some((job) => job.id === jobId);
  }

  function hasVisibleSelection(selected) {
    if (!selected) return false;
    return isVisibleJob(selected);
  }

  function hasPendingDetailRead(jobId, environmentId) {
    if (!pendingDetailRead) return false;
    if (pendingDetailRead.revision !== detailRevision) return false;
    if (pendingDetailRead.environmentId !== environmentId) return false;
    if (pendingDetailRead.jobId !== jobId) return false;
    return pendingDetailRead.cursor === state.runsCursor;
  }

  function shouldShowHistoryLoading(background) {
    if (!background) return true;
    return state.runs.length === 0;
  }

  function shouldOpenEntryEditor(
    openFirstEditor,
    environmentChanged,
    targetJobId,
    readSelectionRevision,
  ) {
    if (readSelectionRevision !== selectionRevision) return false;
    if (targetJobId) return false;
    if (state.editor) return false;
    if (state.mutation) return false;
    if (!active) return false;
    if (openFirstEditor) return true;
    return environmentChanged;
  }

  function canRestoreRequestedJob(targetJobId, readSelectionRevision) {
    if (!targetJobId) return false;
    return readSelectionRevision === selectionRevision;
  }

  function shouldPreserveMissingSelection(selected, readSelectionRevision) {
    if (selected) return false;
    return readSelectionRevision === selectionRevision;
  }

  function openEntryScheduleEditor() {
    const job = firstVisibleJob();
    selectJobIdentity(job?.id || "");
    if (!canManageSchedule(job)) return;
    state.editor = { job, environmentId: getEnvironmentId() };
  }

  function reconcileLoadedSelection(
    openEditor,
    targetJobId,
    readSelectionRevision,
  ) {
    if (canRestoreRequestedJob(targetJobId, readSelectionRevision)) {
      selectJobIdentity(targetJobId);
      return;
    }
    if (state.editor) return;
    if (openEditor) {
      openEntryScheduleEditor();
      return;
    }
    const selected = state.jobs.find((job) => job.id === state.selectedId);
    if (shouldPreserveMissingSelection(selected, readSelectionRevision)) return;
    if (hasVisibleSelection(selected)) return;
    selectJobIdentity(firstVisibleJob()?.id || "");
  }

  function scheduleRefresh() {
    clearTimer(pollTimer);
    if (!active) return;
    pollTimer = setTimer(() => {
      if (state.mutation) {
        scheduleRefresh();
        return;
      }
      void load({ background: true });
    }, 5000);
  }

  async function load({
    background = false,
    openFirstEditor = false,
    targetJobId = "",
  } = {}) {
    const environmentId = getEnvironmentId();
    const revision = ++loadRevision;
    const readSelectionRevision = selectionRevision;
    const environmentChanged = state.environmentId !== environmentId;
    if (environmentChanged) {
      Object.assign(state, {
        environmentId,
        jobs: [],
        sessions: [],
        models: [],
        selectedId: "",
        query: "",
        filter: targetJobId ? "all" : "current",
        runs: [],
        editor: null,
        error: "",
        detailError: "",
      });
      resetRunPages();
      detailRevision += 1;
    }
    state.loading = !background;
    if (!background) publish();
    try {
      const [jobs, sessions, models] = await Promise.all([
        client.listSchedules(environmentId),
        client.listSessions(environmentId),
        client.listModels(environmentId),
      ]);
      if (!hasCurrentListRead(revision, environmentId)) return;
      state.jobs = jobs.jobs || [];
      state.sessions = sessions.sessions || [];
      state.models = models.profiles || [];
      state.defaultModelProfileId = models.defaultProfileId || "";
      state.error = "";
      reconcileLoadedSelection(
        shouldOpenEntryEditor(
          openFirstEditor,
          environmentChanged,
          targetJobId,
          readSelectionRevision,
        ),
        targetJobId,
        readSelectionRevision,
      );
      if (state.selectedId)
        void select(state.selectedId, {
          background: true,
          reusePendingRead: background,
        });
    } catch (error) {
      if (!hasCurrentListRead(revision, environmentId)) return;
      state.error = scheduleErrorMessage(error);
    } finally {
      if (hasCurrentListRead(revision, environmentId)) {
        state.loading = false;
        publish();
        scheduleRefresh();
      }
    }
  }

  async function select(
    jobId,
    { background = false, reusePendingRead = background } = {},
  ) {
    const environmentId = getEnvironmentId();
    if (reusePendingRead && hasPendingDetailRead(jobId, environmentId)) return;
    if (!background) selectionRevision += 1;
    const revision = ++detailRevision;
    selectJobIdentity(jobId);
    state.loadingRuns = shouldShowHistoryLoading(background);
    state.detailError = "";
    if (!hasLoadedJob(jobId)) {
      resetRunPages();
      state.loadingRuns = false;
      publish();
      return;
    }
    const read = { revision, environmentId, jobId, cursor: state.runsCursor };
    pendingDetailRead = read;
    if (!background) publish();
    try {
      const result = await client.listScheduleRuns(jobId, environmentId, {
        cursor: read.cursor ?? undefined,
      });
      if (!hasCurrentDetailRead(revision, environmentId, jobId)) return;
      state.runs = result.runs || [];
      state.runsNextCursor = result.nextCursor ?? null;
    } catch (error) {
      if (!hasCurrentDetailRead(revision, environmentId, jobId)) return;
      state.detailError = scheduleErrorMessage(error);
    } finally {
      if (pendingDetailRead === read) pendingDetailRead = null;
      if (hasCurrentDetailRead(revision, environmentId, jobId)) {
        state.loadingRuns = false;
        publish();
      }
    }
  }

  async function moveRunPage(cursor, previousCursors) {
    state.runsCursor = cursor;
    state.runsPreviousCursors = previousCursors;
    state.runsNextCursor = null;
    state.runs = [];
    await select(state.selectedId);
  }

  async function olderRuns() {
    if (state.loadingRuns || !state.runsNextCursor) return;
    await moveRunPage(state.runsNextCursor, [
      ...state.runsPreviousCursors,
      state.runsCursor,
    ]);
  }

  async function newerRuns() {
    if (state.loadingRuns || !state.runsPreviousCursors.length) return;
    const previous = [...state.runsPreviousCursors];
    await moveRunPage(previous.pop(), previous);
  }

  async function latestRuns() {
    if (state.loadingRuns || state.runsCursor === null) return;
    await moveRunPage(null, []);
  }

  function beginEdit(jobId = "", initialValues = null) {
    selectionRevision += 1;
    state.editor = {
      job: state.jobs.find((job) => job.id === jobId) || null,
      environmentId: getEnvironmentId(),
      initialValues,
    };
    publish();
  }

  function cancelEdit() {
    selectionRevision += 1;
    state.editor = null;
    publish();
    scheduleRefresh();
  }

  async function save(input) {
    const editor = state.editor;
    if (!editor || !isCurrentEnvironment(editor.environmentId))
      throw new Error("The environment changed. Reopen the schedule editor.");
    state.mutation = "save";
    try {
      const result = editor.job
        ? await client.updateSchedule(
            editor.job.id,
            input,
            editor.environmentId,
          )
        : await client.createSchedule(input, editor.environmentId);
      if (!isCurrentEnvironment(editor.environmentId)) return;
      state.editor = null;
      selectJobIdentity(result.job.id);
      await load();
    } finally {
      state.mutation = "";
      publish();
    }
  }

  async function action(jobId, actionName) {
    if (state.mutation) return;
    const environmentId = getEnvironmentId();
    state.mutation = actionName;
    state.error = "";
    publish();
    try {
      await client.scheduleAction(jobId, actionName, environmentId);
      if (isCurrentEnvironment(environmentId)) await load();
    } catch (error) {
      if (isCurrentEnvironment(environmentId))
        state.error = scheduleErrorMessage(error);
    } finally {
      state.mutation = "";
      publish();
    }
  }

  async function openJob(jobId) {
    selectionRevision += 1;
    Object.assign(state, { query: "", filter: "all", editor: null });
    selectJobIdentity(jobId);
    await load({ targetJobId: jobId });
  }

  async function openCreate(initialValues = {}) {
    const environmentId = getEnvironmentId();
    const revision = ++selectionRevision;
    await load();
    if (!isCurrentEnvironment(environmentId)) return;
    if (revision !== selectionRevision) return;
    if (state.error) return;
    beginEdit("", {
      ...initialValues,
      modelProfileId: initialValues.modelProfileId || state.defaultModelProfileId,
    });
  }

  async function filter(query, filter) {
    selectionRevision += 1;
    Object.assign(state, { query, filter });
    if (state.editor) {
      publish();
      return;
    }
    const selected = state.jobs.find((job) => job.id === state.selectedId);
    if (hasVisibleSelection(selected)) {
      publish();
      return;
    }
    const job = firstVisibleJob();
    await select(job?.id || "");
  }

  return {
    load,
    select,
    olderRuns,
    newerRuns,
    latestRuns,
    beginEdit,
    cancelEdit,
    save,
    action,
    openJob,
    openCreate,
    snapshot: () => ({ ...state }),
    filter,
    setActive(value) {
      const entering = value && !active;
      active = value;
      if (active) {
        void load({ openFirstEditor: entering });
        return;
      }
      loadRevision += 1;
      detailRevision += 1;
      state.loading = false;
      state.loadingRuns = false;
      clearTimer(pollTimer);
    },
    openConversation: (sessionId, requestId) =>
      openConversation(sessionId, requestId),
  };
}
