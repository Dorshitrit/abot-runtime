const PAGE_SIZE = 50;
const emptyFilters = () => ({ status: "", from: "", to: "" });

function localDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day)
    return null;
  return date;
}

function historyQuery(filters) {
  const query = { limit: PAGE_SIZE };
  if (filters.status) query.status = filters.status;
  const from = filters.from ? localDay(filters.from) : null;
  const to = filters.to ? localDay(filters.to) : null;
  if (filters.from && !from) throw new Error("Choose a valid start date.");
  if (filters.to && !to) throw new Error("Choose a valid end date.");
  if (to) to.setDate(to.getDate() + 1);
  if (from && to && from >= to) throw new Error("The end date must be on or after the start date.");
  if (from) query.from = from.toISOString();
  if (to) query.to = to.toISOString();
  return query;
}

export function automationRunPage(response) {
  return {
    runs: Array.isArray(response?.runs) ? response.runs : [],
    runsNextCursor: typeof response?.nextCursor === "string" ? response.nextCursor : null,
  };
}

function appendRunPage(runs, page) {
  const entries = new Map(runs.map((run) => [run.id, run]));
  for (const run of page) entries.set(run.id, run);
  return [...entries.values()];
}

/** History belongs to an automation/environment, independently of its selected report. */
export function createAutomationRunHistory({ state, client, getEnvironmentId, publish, errorLabel }) {
  let revision = 0;
  let loaded = false;
  let pages = 0;
  let failedRead = null;
  let pendingFilters = null;

  function resetScope() {
    revision += 1;
    loaded = false;
    pages = 0;
    failedRead = null;
    pendingFilters = null;
    Object.assign(state, { runs: [], runsNextCursor: null, runsLoading: false,
      runsError: "", runsFilterError: "", runsFilters: emptyFilters() });
  }

  function captureScope() {
    const environmentId = getEnvironmentId(), automationId = state.selectedAutomationId;
    const capturedRevision = revision;
    return { environmentId, automationId, isCurrent: () => capturedRevision === revision &&
      environmentId === getEnvironmentId() && automationId === state.selectedAutomationId };
  }

  function canRefreshFirstPage(refresh) {
    if (state.runsLoading) return false;
    if (failedRead) return false;
    if (!loaded) return true;
    return refresh && pages < 2;
  }

  function captureRead({ refresh = false } = {}) {
    const scope = captureScope();
    const query = scope.automationId && canRefreshFirstPage(refresh) ? historyQuery(state.runsFilters) : null;
    return { query, isCurrent: scope.isCurrent, accept(projection) {
      if (!query || !scope.isCurrent()) return;
      state.runs = projection.runs;
      state.runsNextCursor = projection.runsNextCursor;
      loaded = true;
      pages = 1;
    } };
  }

  async function readPage(filters, query, kind, isCurrent = () => true) {
    revision += 1;
    const scope = captureScope();
    const canApplyHistoryRead = () => scope.isCurrent() && isCurrent();
    failedRead = null;
    pendingFilters = filters;
    state.runsLoading = true;
    state.runsError = "";
    state.runsFilterError = "";
    publish();
    try {
      const response = await client.listAutomationRuns(scope.automationId, scope.environmentId, query);
      if (!canApplyHistoryRead()) return false;
      const page = automationRunPage(response);
      state.runs = kind === "more" ? appendRunPage(state.runs, page.runs) : page.runs;
      state.runsNextCursor = page.runsNextCursor;
      state.runsFilters = filters;
      loaded = true;
      pages = kind === "more" ? pages + 1 : 1;
      return true;
    } catch (error) {
      if (!canApplyHistoryRead()) return false;
      if (kind === "filter") {
        state.runsFilterError = errorLabel(error);
        return false;
      }
      state.runsError = errorLabel(error);
      failedRead = { filters, query, kind };
      return false;
    } finally {
      if (scope.isCurrent()) {
        pendingFilters = null;
        state.runsLoading = false;
        publish();
      }
    }
  }

  async function setRunFilters(input) {
    if (!state.selectedAutomationId) return false;
    const filters = { status: input?.status || "", from: input?.from || "", to: input?.to || "" };
    let query;
    try { query = historyQuery(filters); }
    catch (error) {
      state.runsFilterError = errorLabel(error);
      publish();
      return false;
    }
    return readPage(filters, query, "filter");
  }

  function loadMoreRuns() {
    if (!state.selectedAutomationId || !state.runsNextCursor || state.runsLoading) return false;
    return readPage(state.runsFilters,
      { ...historyQuery(state.runsFilters), cursor: state.runsNextCursor }, "more");
  }

  function resetRunHistory({ isCurrent = () => true, supersede = false } = {}) {
    if (!state.selectedAutomationId || !isCurrent()) return false;
    if (state.runsLoading && !supersede) return false;
    const filters = pendingFilters || state.runsFilters;
    return readPage(filters, historyQuery(filters), "reset", isCurrent);
  }

  function retryRunHistory() {
    if (!failedRead || state.runsLoading) return false;
    const { filters, query, kind } = failedRead;
    return readPage(filters, query, kind);
  }

  resetScope();
  return { resetScope, captureRead, revision: () => revision,
    setRunFilters, loadMoreRuns, resetRunHistory, retryRunHistory };
}
