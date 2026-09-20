function isPersistedPageRestore(event) {
  return event.persisted === true;
}

export function bindRuntimeSetupPageLifecycle({ page, dispose, reloadModels }) {
  function restoreSetupAfterPageShow(event) {
    if (!isPersistedPageRestore(event)) return;
    void reloadModels();
  }

  page.addEventListener("pagehide", dispose);
  page.addEventListener("pageshow", restoreSetupAfterPageShow);
}
