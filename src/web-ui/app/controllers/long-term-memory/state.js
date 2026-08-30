import { lastPageOffset, previousPageOffsetAfterDelete } from "./policy.js";

export function createLongTermMemoryState(pageSize) {
  return {
    enabled: null,
    available: null,
    items: [],
    total: 0,
    offset: 0,
    limit: pageSize,
    query: "",
    loading: false,
    mutation: "",
    message: "",
    error: "",
    editor: null,
  };
}

export function snapshotLongTermMemoryState(state) {
  const editorDraft = state.editor?.draft
    ? Object.freeze({
        ...state.editor.draft,
        tags: Object.freeze([...state.editor.draft.tags]),
      })
    : null;
  return Object.freeze({
    ...state,
    items: Object.freeze([...state.items]),
    editor: state.editor
      ? Object.freeze({
          ...state.editor,
          ...(editorDraft ? { draft: editorDraft } : {}),
        })
      : null,
  });
}

export function applyMemoryRecords(state, payload) {
  state.items = Array.isArray(payload?.items) ? payload.items : [];
  state.total = Number.isSafeInteger(payload?.total) ? payload.total : 0;
  if (!payload?.status) return;
  state.enabled = payload.status.enabled === true;
  state.available = payload.status.available === true;
}

export function applyMemoryAvailabilityFailure(state, error) {
  if (error?.code === "long_term_memory_disabled") {
    state.enabled = false;
    return;
  }
  if (error?.code === "long_term_memory_unavailable") {
    state.available = false;
  }
}

export function applyCreatedMemory(state, record) {
  const wasBrowsingList = state.query === "";
  const previousOffset = state.offset;
  state.query = "";
  state.total += 1;
  state.offset = lastPageOffset(state.total, state.limit);
  const staysOnCurrentPage = wasBrowsingList && previousOffset === state.offset;
  if (!record) state.items = [];
  else if (staysOnCurrentPage) state.items = [...state.items, record];
  else state.items = [record];
}

export function applyUpdatedMemory(state, record) {
  if (!record) return;
  state.items = state.items.map((item) =>
    item.id === record.id ? record : item,
  );
}

export function applyDeletedMemory(state, recordId) {
  state.offset = previousPageOffsetAfterDelete(state);
  state.total = Math.max(0, state.total - 1);
  state.items = state.items.filter((record) => record.id !== recordId);
}

export function clearMemoryFeedback(state) {
  state.message = "";
  state.error = "";
}
