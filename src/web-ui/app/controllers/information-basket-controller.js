import { createBasketPickerController } from "./information-basket-picker-controller.js";
import { filterBasketSources, isBasketSourceWorking } from "../lib/information-basket-presentation.js";
import { normalizeRealtimeMessage } from "../lib/realtime-message.js";

/** One environment-bound management projection. The Runtime owns every persisted source. */
export function createInformationBasketController({ client, getEnvironmentId, render,
  isVisible = () => true, confirmRemove = async () => false }) {
  const state = { view: null, query: "", filter: "all", selected: [], detailId: "",
    loading: false, mutation: "", error: "", message: "", settingsDraft: null, settingsDirty: false };
  let epoch = 0;
  let listRead = 0;
  let errorKind = "";
  let active = false;
  let refreshPending = null;
  let refreshAgain = false;
  const picker = createBasketPickerController({ client, getEnvironmentId, render: publish, register,
    getRegistrationError: () => state.error, getSelectionLimit: () => state.view?.limits?.maxSources ?? 200 });
  function snapshot() {
    const sources = [...(state.view?.sources || [])];
    return { ...state, sources, visibleSources: filterBasketSources(sources, state.query, state.filter),
      selected: [...state.selected], picker: picker.snapshot(),
      detail: sources.find((source) => source.sourceId === state.detailId) || null };
  }
  function publish() { render(snapshot()); }
  const capture = () => ({ epoch, environmentId: getEnvironmentId() });
  function isCurrentBasketScope(scope) { return scope.epoch === epoch && scope.environmentId === getEnvironmentId(); }
  function canRefreshBasketView() { return active && isVisible() && client.supportsInformationBasket(); }
  function acceptView(view) {
    state.view = view;
    const availableIds = new Set(view.sources.map((source) => source.sourceId));
    state.selected = state.selected.filter((id) => availableIds.has(id));
    if (!availableIds.has(state.detailId)) state.detailId = "";
    if (!state.settingsDirty) state.settingsDraft = { ...view.settings };
  }
  async function readList() {
    const scope = capture();
    const read = ++listRead;
    state.loading = true;
    publish();
    try {
      const view = await client.listInformationBasket(scope.environmentId);
      if (!isCurrentBasketScope(scope) || read !== listRead) return;
      acceptView(view);
      if (errorKind === "read") { state.error = ""; errorKind = ""; }
    } catch (error) {
      if (isCurrentBasketScope(scope) && read === listRead) { state.error = error.message || String(error); errorKind = "read"; }
    } finally {
      if (isCurrentBasketScope(scope) && read === listRead) { state.loading = false; publish(); }
    }
  }
  function refresh() {
    if (!canRefreshBasketView()) return Promise.resolve();
    if (state.mutation) { refreshAgain = true; return Promise.resolve(); }
    if (refreshPending) { refreshAgain = true; return refreshPending; }
    const currentEpoch = epoch;
    const pending = readList().finally(() => {
      if (currentEpoch !== epoch || refreshPending !== pending) return;
      refreshPending = null;
      if (!refreshAgain) return;
      refreshAgain = false;
      void refresh();
    });
    refreshPending = pending;
    return pending;
  }
  async function mutate(name, execute, onAccepted) {
    if (state.mutation || !client.supportsInformationBasket()) return false;
    const scope = capture();
    listRead += 1;
    state.loading = false;
    state.mutation = name;
    errorKind = "";
    state.error = "";
    state.message = "";
    publish();
    try {
      const result = await execute(scope.environmentId);
      if (!isCurrentBasketScope(scope)) return false;
      onAccepted?.();
      acceptView(result);
      return true;
    } catch (error) {
      if (isCurrentBasketScope(scope)) { state.error = error.message || String(error); errorKind = "mutation"; refreshAgain = true; }
      return false;
    } finally {
      if (isCurrentBasketScope(scope)) {
        state.mutation = "";
        publish();
        if (refreshAgain) { refreshAgain = false; void refresh(); }
      }
    }
  }
  async function register(paths) {
    if (!paths.length) return false;
    return mutate("register", (environment) => client.registerInformationBasketSources(paths, environment), () => {
      state.message = "Sources linked. Original files stay where they are.";
    });
  }
  function findSource(id) { return snapshot().sources.find((source) => source.sourceId === id); }
  async function remove(ids) {
    if (state.mutation) return false;
    const sources = ids.map(findSource).filter(Boolean);
    if (!sources.length) return false;
    const scope = capture();
    if (!await confirmRemove(sources.length)) return false;
    if (!isCurrentBasketScope(scope) || state.mutation) return false;
    return mutate("remove", async (environment) => {
      let result;
      for (const source of sources) {
        if (!isCurrentBasketScope(scope)) return result;
        result = await client.removeInformationBasketSource(source.sourceId, source.revision, environment);
      }
      return result;
    }, () => { state.message = "Removed from the basket. Original files were not deleted."; });
  }
  async function reindex(ids) {
    const sources = ids.map(findSource).filter((source) => source && !isBasketSourceWorking(source));
    if (!sources.length) return false;
    const scope = capture();
    return mutate("reindex", async (environment) => {
      let result;
      for (const source of sources) {
        if (!isCurrentBasketScope(scope)) return result;
        result = await client.reindexInformationBasketSource(source.sourceId, source.revision, environment);
      }
      return result;
    }, () => { state.message = "Sources queued for indexing."; });
  }
  function changeSettings(field, value) {
    if (!state.settingsDraft || state.mutation) return;
    if (field !== "enabled" && field !== "embeddingProfileId" && field !== "indexChatUploads" && field !== "matchMode") return;
    state.settingsDraft = { ...state.settingsDraft, [field]: value };
    state.settingsDirty = true;
    publish();
  }
  function saveSettings() {
    if (!state.settingsDraft || !state.settingsDirty) return Promise.resolve(false);
    const { revision, enabled, embeddingProfileId, indexChatUploads = false, matchMode = "balanced" } = state.settingsDraft;
    return mutate("settings", (environment) => client.saveInformationBasketSettings({
      expectedRevision: revision, enabled, indexChatUploads, matchMode, embeddingProfileId: embeddingProfileId || null,
    }, environment), () => { state.settingsDirty = false; state.message = "Resource settings saved."; });
  }
  function environmentChanged() {
    epoch += 1;
    listRead += 1;
    refreshPending = null;
    refreshAgain = false;
    errorKind = "";
    Object.assign(state, { view: null, selected: [], detailId: "", loading: false,
      mutation: "", error: "", message: "", settingsDraft: null, settingsDirty: false });
    picker.environmentChanged();
    publish();
    return refresh();
  }
  function handleRealtime(raw) {
    const message = normalizeRealtimeMessage(raw);
    if ((message.environment || message.environmentId) !== getEnvironmentId()) return;
    if (message.type !== "workspace_changed") return;
    if (!message.resources?.includes("information-basket")) return;
    void refresh();
  }
  return { snapshot, refresh, register, remove, reindex, changeSettings, saveSettings,
    picker, environmentChanged, handleRealtime,
    resetSettings() { if (!state.view || state.mutation) return; state.settingsDirty = false; state.settingsDraft = { ...state.view.settings }; publish(); },
    setActive(value) { active = value; if (!active) { state.detailId = ""; picker.close(); } else void refresh(); },
    reconnect: refresh, visibilityChanged: refresh,
    setQuery(value) { state.query = value; publish(); },
    setFilter(value) { state.filter = value; publish(); },
    select(id, selected) {
      if (!findSource(id)) return;
      state.selected = state.selected.filter((value) => value !== id);
      if (selected) state.selected.push(id);
      publish();
    },
    selectVisible(selected) {
      const ids = snapshot().visibleSources.map((source) => source.sourceId);
      state.selected = state.selected.filter((id) => !ids.includes(id));
      if (selected) state.selected.push(...ids);
      publish();
    },
    showDetails(id) { state.detailId = id; publish(); },
  };
}
