import { revealSelectedAutomationRun } from "./run-history.js";

function readFilterFields(form) {
  return Object.fromEntries(["status", "from", "to"].map((name) =>
    [name, form.querySelector(`[name="${name}"]`)?.value || ""]));
}

function canScrollForMore(snapshot, list) {
  if (!snapshot.runsNextCursor || snapshot.runsLoading || snapshot.runsError) return false;
  if (list.clientHeight <= 0) return false;
  return list.scrollHeight - list.scrollTop - list.clientHeight <= 80;
}

export function createAutomationRunHistoryControls({ root, actions }) {
  let current = {};
  let appliedKey = "";
  let filterDraft = null;
  let pendingLoad = null;
  let resetScroll = false;

  async function loadMore() {
    if (pendingLoad || current.runsLoading) return;
    const pending = {};
    pendingLoad = pending;
    try {
      if (current.runsError) await actions.retryRunHistory();
      else await actions.loadMoreRuns();
    } finally { if (pendingLoad === pending) pendingLoad = null; }
  }

  function captureFilters(event) {
    const form = event.target.closest("[data-run-history-filters]");
    if (form) filterDraft = readFilterFields(form);
  }
  root.addEventListener("input", captureFilters);
  root.addEventListener("change", captureFilters);
  root.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-run-history-filters]");
    if (!form) return;
    event.preventDefault();
    filterDraft = readFilterFields(form);
    resetScroll = true;
    void actions.setRunFilters(filterDraft);
  });
  root.addEventListener("click", (event) => {
    if (event.target.closest("[data-load-more-runs]")) void loadMore();
    if (event.target.closest("[data-reset-run-history]")) {
      filterDraft = null;
      resetScroll = true;
      void actions.resetRunHistory();
    }
  });
  root.addEventListener("scroll", (event) => {
    const list = root.querySelector("#automation-run-history-list");
    if (event.target !== list || !list) return;
    if (canScrollForMore(current, list)) void loadMore();
  }, true);

  function sync(snapshot, { viewChanged = false, focus = false } = {}) {
    current = snapshot;
    const nextKey = JSON.stringify([snapshot.selectedAutomationId, snapshot.runsFilters || {}]);
    const filtersChanged = nextKey !== appliedKey;
    if (filtersChanged) { filterDraft = null; pendingLoad = null; appliedKey = nextKey; }
    const form = root.querySelector("[data-run-history-filters]");
    if (form && filterDraft) {
      for (const [name, value] of Object.entries(filterDraft)) {
        const input = form.querySelector(`[name="${name}"]`);
        if (input) input.value = value;
      }
    }
    const list = root.querySelector("#automation-run-history-list");
    if (list && (filtersChanged || resetScroll)) list.scrollTop = 0;
    resetScroll = false;
    if (viewChanged) revealSelectedAutomationRun(root, { focus });
  }
  return { sync };
}
