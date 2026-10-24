const storageKey = "abot-web.sessionSidebarByEnvironment";

function preferenceIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === "string" && id))];
}

function readEnvironments(storage) {
  try {
    const value = JSON.parse(storage.getItem(storageKey) || "{}");
    if (!value || typeof value !== "object") return Object.create(null);
    if (Array.isArray(value)) return Object.create(null);
    return Object.assign(Object.create(null), value);
  } catch {
    return Object.create(null);
  }
}

function saveSidebarPreferenceFields(storage, environmentId, changedFields) {
  const environments = readEnvironments(storage);
  const saved = environments[environmentId];
  const value = {
    archivedSessionIds: preferenceIds(saved?.archivedSessionIds),
    orderedSessionIds: preferenceIds(saved?.orderedSessionIds),
  };
  if (saved?.collapsedProjectIds !== undefined)
    value.collapsedProjectIds = preferenceIds(saved.collapsedProjectIds);
  Object.assign(value, changedFields);
  Object.defineProperty(environments, environmentId, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return storage.setItem(storageKey, JSON.stringify(environments));
}

export function createSessionSidebarPreferences(storage) {
  return {
    loadSessionSidebar(environmentId) {
      const saved = readEnvironments(storage)[environmentId];
      return {
        archivedSessionIds: preferenceIds(saved?.archivedSessionIds),
        orderedSessionIds: preferenceIds(saved?.orderedSessionIds),
      };
    },
    saveSessionSidebar(environmentId, value) {
      return saveSidebarPreferenceFields(storage, environmentId, {
        archivedSessionIds: preferenceIds(value.archivedSessionIds),
        orderedSessionIds: preferenceIds(value.orderedSessionIds),
      });
    },
    loadCollapsedProjectIds(environmentId) {
      return preferenceIds(readEnvironments(storage)[environmentId]?.collapsedProjectIds);
    },
    saveCollapsedProjectIds(environmentId, ids) {
      return saveSidebarPreferenceFields(storage, environmentId, {
        collapsedProjectIds: preferenceIds(ids),
      });
    },
  };
}
