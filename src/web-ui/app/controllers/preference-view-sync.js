function sidebarPreferenceScope(preferences, environmentId) {
  return JSON.stringify({
    environmentId,
    pinnedSessionIds: preferences.loadPinnedSessions(),
    sidebar: preferences.loadSessionSidebar(environmentId),
  });
}

/** Selection acknowledgements update controls, not the sidebar's loaded pages. */
export function createPreferenceViewSync({
  preferences, selection, dashboard, getEnvironmentId, loadSessions,
}) {
  let ready = false;
  let sidebarScope;

  function synchronize() {
    selection.loadPreferences();
    if (!ready) return;
    selection.applyModelSelection();
    selection.renderPermissionMode();
    void dashboard.refresh();
    const nextScope = sidebarPreferenceScope(preferences, getEnvironmentId());
    if (nextScope === sidebarScope) return;
    sidebarScope = nextScope;
    void loadSessions();
  }

  return {
    synchronize,
    setReady() {
      ready = true;
      synchronize();
    },
  };
}
