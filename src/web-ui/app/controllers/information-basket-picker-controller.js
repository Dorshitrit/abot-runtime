/** Owns the Runtime-host picker; browser File objects never enter this boundary. */
export function createBasketPickerController({ client, getEnvironmentId, render, register,
  getRegistrationError = () => "", getSelectionLimit = () => 200 }) {
  let epoch = 0;
  let read = 0;
  let state = emptyState();
  function emptyState() {
    return { open: false, loading: false, selectingAll: false, page: null, selectedPaths: [], pathDraft: "", linkId: "", linkName: "", error: "" };
  }
  const snapshot = () => ({ ...state, selectedPaths: [...state.selectedPaths] });
  const publish = () => render();
  const capture = () => ({ epoch, environmentId: getEnvironmentId(), read: ++read });
  function isCurrentPickerRead(scope) {
    if (scope.epoch !== epoch || scope.read !== read) return false;
    return scope.environmentId === getEnvironmentId();
  }
  function isSelectableBasketFile(entry) { return entry?.kind === "file" && entry.supported; }
  function exceedsBasketSelectionLimit(count) { return count > getSelectionLimit(); }
  function isRequestedBasketDirectory(page, directory) { return page.directory === directory; }
  function hasRepeatedBasketPageCursor(cursor, cursors) { return Boolean(cursor) && cursors.has(cursor); }
  function selectionLimitError() { return `Select up to ${getSelectionLimit()} files. This selection exceeds the basket limit.`; }
  function canSelectBasketFolder() {
    if (!state.open || state.loading || state.linkId) return false;
    return Boolean(state.page);
  }
  async function browse(path = "", cursor = "") {
    if (!state.open) return;
    const scope = capture();
    state.loading = true;
    state.selectingAll = false;
    state.error = "";
    publish();
    try {
      const page = await client.browseInformationBasket(path, scope.environmentId, cursor);
      if (!isCurrentPickerRead(scope) || !state.open) return;
      const sameDirectory = cursor && state.page?.directory === page.directory;
      const entries = sameDirectory ? [...state.page.entries, ...page.entries] : page.entries;
      state.page = { ...page, entries };
      state.pathDraft = page.directory;
      if (!sameDirectory) state.selectedPaths = [];
    } catch (error) {
      if (isCurrentPickerRead(scope)) state.error = error.message || String(error);
    } finally {
      if (isCurrentPickerRead(scope)) { state.loading = false; publish(); }
    }
  }
  function open(pending) {
    epoch += 1;
    state = { ...emptyState(), open: true, linkId: pending?.sourceId || "", linkName: pending?.displayName || "" };
    publish();
    return browse();
  }
  function close() { epoch += 1; state = emptyState(); publish(); }
  function select(path) {
    if (state.loading) return;
    const entry = state.page?.entries.find((item) => item.path === path);
    if (!isSelectableBasketFile(entry)) return;
    state.error = "";
    if (state.linkId) { state.selectedPaths = [path]; publish(); return; }
    if (state.selectedPaths.includes(path)) {
      state.selectedPaths = state.selectedPaths.filter((item) => item !== path);
      publish(); return;
    }
    if (exceedsBasketSelectionLimit(state.selectedPaths.length + 1)) {
      state.error = selectionLimitError(); publish(); return;
    }
    state.selectedPaths = [...state.selectedPaths, path];
    publish();
  }
  async function selectAll() {
    if (!canSelectBasketFolder()) return false;
    const scope = capture();
    const directory = state.page.directory;
    const entries = new Map();
    const paths = new Set();
    const cursors = new Set();
    let cursor = "";
    let page;
    state.loading = true;
    state.selectingAll = true;
    state.error = "";
    publish();
    try {
      do {
        page = await client.browseInformationBasket(directory, scope.environmentId, cursor);
        if (!isCurrentPickerRead(scope) || !state.open) return false;
        if (!isRequestedBasketDirectory(page, directory)) throw new Error("This folder changed. Open it again before selecting files.");
        for (const entry of page.entries) {
          entries.set(entry.path, entry);
          if (isSelectableBasketFile(entry)) paths.add(entry.path);
        }
        if (exceedsBasketSelectionLimit(paths.size)) throw new Error(selectionLimitError());
        cursor = page.nextCursor;
        if (hasRepeatedBasketPageCursor(cursor, cursors)) throw new Error("The folder listing changed. Open it again before selecting files.");
        cursors.add(cursor);
      } while (cursor);
      state.page = { ...page, entries: [...entries.values()] };
      state.selectedPaths = [...paths];
      return true;
    } catch (error) {
      if (isCurrentPickerRead(scope)) state.error = error.message || String(error);
      return false;
    } finally {
      if (isCurrentPickerRead(scope)) { state.loading = false; state.selectingAll = false; publish(); }
    }
  }
  function clearSelection() {
    if (state.loading || state.linkId) return;
    state.selectedPaths = [];
    state.error = "";
    publish();
  }
  async function submit(paths = state.selectedPaths) {
    if (!paths.length || state.loading) return false;
    if (exceedsBasketSelectionLimit(paths.length)) { state.error = selectionLimitError(); publish(); return false; }
    const currentEpoch = epoch;
    const accepted = await register([...paths], state.linkId);
    if (currentEpoch !== epoch) return accepted;
    if (accepted) close();
    else { state.error = getRegistrationError() || "The source could not be linked. Check its path and try again."; publish(); }
    return accepted;
  }
  return { snapshot, open, close, browse, select, selectAll, clearSelection, submit,
    environmentChanged: close,
    setPath(value) { state.pathDraft = value; },
    browseDraft: () => browse(state.pathDraft.trim()),
    addDraft: () => submit(state.pathDraft.trim() ? [state.pathDraft.trim()] : []),
    more: () => state.page?.nextCursor && browse(state.page.directory, state.page.nextCursor),
  };
}
