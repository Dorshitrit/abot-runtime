import {
  canUseMemoryEmbeddings,
  isAbortError,
  isMemoryConflictError,
  isMemoryMissingError,
  managementErrorMessage,
  unavailableMemoryActionMessage,
} from "./policy.js";
import {
  applyCreatedMemory,
  applyDeletedMemory,
  applyMemoryAvailabilityFailure,
  applyMemoryRecords,
  applyUpdatedMemory,
  clearMemoryFeedback,
  createLongTermMemoryState,
  snapshotLongTermMemoryState,
} from "./state.js";

const DEFAULT_PAGE_SIZE = 20;

export function createLongTermMemoryController({
  client,
  getEnvironmentId,
  render,
  pageSize = DEFAULT_PAGE_SIZE,
}) {
  const state = createLongTermMemoryState(pageSize);
  let readRevision = 0;
  let activeRead = null;

  function publish() {
    render(snapshot());
  }

  function snapshot() {
    return snapshotLongTermMemoryState(state);
  }

  async function load() {
    state.enabled = null;
    state.available = null;
    state.items = [];
    state.total = 0;
    state.query = "";
    state.offset = 0;
    state.mutation = "";
    state.editor = null;
    clearMemoryFeedback(state);
    await loadRecords({ preserveFeedback: true });
  }

  async function refresh() {
    await loadRecords({ preserveFeedback: false });
  }

  async function search(query) {
    const normalized = String(query ?? "").trim();
    if (!normalized) {
      state.query = "";
      state.offset = 0;
      await loadRecords({ preserveFeedback: false });
      return;
    }
    if (!canUseMemoryEmbeddings(state)) {
      state.error = unavailableMemoryActionMessage("search");
      publish();
      return;
    }
    state.query = normalized;
    state.offset = 0;
    await loadRecords({ preserveFeedback: false });
  }

  async function changePage(direction) {
    const nextOffset = state.offset + direction * state.limit;
    if (nextOffset < 0 || nextOffset >= state.total) return;
    state.offset = nextOffset;
    await loadRecords({ preserveFeedback: false });
  }

  function beginCreate() {
    if (!canUseMemoryEmbeddings(state)) {
      state.error = unavailableMemoryActionMessage("create");
      publish();
      return;
    }
    clearMemoryFeedback(state);
    state.editor = { mode: "create", recordId: "" };
    publish();
  }

  function beginEdit(recordId) {
    if (!canUseMemoryEmbeddings(state)) {
      state.error = unavailableMemoryActionMessage("edit");
      publish();
      return;
    }
    if (!findRecord(recordId)) return;
    clearMemoryFeedback(state);
    state.editor = { mode: "edit", recordId };
    publish();
  }

  function cancelEdit() {
    state.editor = null;
    clearMemoryFeedback(state);
    publish();
  }

  async function save({ content, tags }) {
    const editor = state.editor;
    if (!editor || state.mutation) return;
    const environmentId = getEnvironmentId();
    state.editor = {
      ...editor,
      draft: { content, tags: [...tags] },
    };
    state.mutation = editor.mode;
    clearMemoryFeedback(state);
    publish();
    try {
      await saveEditor({ editor, environmentId, content, tags });
    } catch (error) {
      await handleMutationFailure(error, editor);
    } finally {
      finishMutation(environmentId);
    }
  }

  async function saveEditor({ editor, environmentId, content, tags }) {
    if (editor.mode === "create") {
      await createMemory({ environmentId, content, tags });
      return;
    }
    await updateMemory({
      environmentId,
      recordId: editor.recordId,
      content,
      tags,
    });
  }

  async function createMemory({ environmentId, content, tags }) {
    const result = await client.createLongTermMemory({
      environmentId,
      content,
      tags,
    });
    if (environmentId !== getEnvironmentId()) return;
    state.editor = null;
    state.message = "Memory created.";
    applyCreatedMemory(state, result.record);
    await loadRecords({ preserveFeedback: true });
  }

  async function updateMemory({ environmentId, recordId, content, tags }) {
    const record = findRecord(recordId);
    if (!record) {
      state.error = "This memory is no longer in the current list.";
      return;
    }
    const result = await client.updateLongTermMemory({
      environmentId,
      id: record.id,
      content,
      tags,
      expectedUpdatedAt: record.updatedAt,
    });
    if (environmentId !== getEnvironmentId()) return;
    state.editor = null;
    state.message = "Memory updated.";
    applyUpdatedMemory(state, result.record);
    await loadRecords({ preserveFeedback: true });
  }

  async function deleteMemory(recordId) {
    if (state.mutation || !findRecord(recordId)) return;
    const environmentId = getEnvironmentId();
    state.mutation = `delete:${recordId}`;
    clearMemoryFeedback(state);
    publish();
    try {
      await client.deleteLongTermMemory({ environmentId, id: recordId });
      await applySuccessfulDelete(environmentId, recordId);
    } catch (error) {
      await handleDeleteFailure(error);
    } finally {
      finishMutation(environmentId);
    }
  }

  async function applySuccessfulDelete(environmentId, recordId) {
    if (environmentId !== getEnvironmentId()) return;
    if (state.editor?.recordId === recordId) state.editor = null;
    state.message = "Memory deleted.";
    applyDeletedMemory(state, recordId);
    await loadRecords({ preserveFeedback: true });
  }

  async function handleDeleteFailure(error) {
    applyMemoryAvailabilityFailure(state, error);
    state.error = managementErrorMessage(error);
    if (isMemoryMissingError(error)) {
      await loadRecords({ preserveFeedback: true });
    }
  }

  async function handleMutationFailure(error, editor) {
    applyMemoryAvailabilityFailure(state, error);
    state.error = managementErrorMessage(error);
    if (!isMemoryConflictError(error) || editor.mode !== "edit") return;
    state.editor = { mode: "edit", recordId: editor.recordId };
    await loadRecords({ preserveFeedback: true });
  }

  async function loadRecords({ preserveFeedback }) {
    const request = beginRead();
    if (!preserveFeedback) clearMemoryFeedback(state);
    state.loading = true;
    publish();
    try {
      const payload = await requestRecords(request);
      if (!isCurrentRead(request)) return;
      applyMemoryRecords(state, payload);
    } catch (error) {
      if (!isCurrentRead(request) || isAbortError(error)) return;
      applyMemoryAvailabilityFailure(state, error);
      state.error = managementErrorMessage(error);
    } finally {
      finishRead(request);
    }
  }

  function requestRecords(request) {
    const page = {
      environmentId: request.environmentId,
      limit: state.limit,
      offset: state.offset,
      signal: request.controller.signal,
    };
    return state.query
      ? client.searchLongTermMemories({ ...page, query: state.query })
      : client.listLongTermMemories(page);
  }

  function beginRead() {
    activeRead?.abort();
    const request = {
      revision: ++readRevision,
      environmentId: getEnvironmentId(),
      controller: new AbortController(),
    };
    activeRead = request.controller;
    return request;
  }

  function isCurrentRead(request) {
    return (
      request.revision === readRevision &&
      request.environmentId === getEnvironmentId()
    );
  }

  function finishRead(request) {
    if (!isCurrentRead(request)) return;
    state.loading = false;
    activeRead = null;
    publish();
  }

  function finishMutation(environmentId) {
    if (environmentId !== getEnvironmentId()) return;
    state.mutation = "";
    publish();
  }

  function findRecord(recordId) {
    return state.items.find((record) => record.id === recordId);
  }

  function dispose() {
    readRevision += 1;
    activeRead?.abort();
    activeRead = null;
  }

  publish();
  return Object.freeze({
    beginCreate,
    beginEdit,
    cancelEdit,
    changePage,
    deleteMemory,
    dispose,
    load,
    refresh,
    save,
    search,
    snapshot,
  });
}
