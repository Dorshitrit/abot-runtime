const storageKeys = {
  environmentId: "abot-web.environmentId",
  pinnedSessions: "abot-web.pinnedSessions",
  currentSessionByEnvironment: "abot-web.currentSessionByEnvironment",
  sessionModes: "abot-web.sessionModes",
  lastToolPermissionMode: "abot-web.lastToolPermissionMode",
  sessionModels: "abot-web.sessionModels",
  lastModelByEnvironment: "abot-web.lastModelByEnvironment",
};

function parseObject(storage, key) {
  try {
    const raw = storage.getItem(key);
    const value = raw ? JSON.parse(raw) : {};
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

function restoreSessionMode(value, normalizeToolPermissionMode) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) return null;
  const mode = normalizeToolPermissionMode(value.toolPermissionMode);
  if (mode === "ask") {
    return { toolPermissionMode: mode, savedAt: value.savedAt || Date.now() };
  }
  const hasExplicitFullMode = ["full_access", "full_plus"].includes(value.toolPermissionMode);
  if (!hasExplicitFullMode) return null;
  return { toolPermissionMode: mode, savedAt: value.savedAt || Date.now() };
}

export function createClientPreferences(storage) {
  return {
    loadPinnedSessions() {
      try {
        const raw = storage.getItem(storageKeys.pinnedSessions);
        const value = raw ? JSON.parse(raw) : [];
        return Array.isArray(value)
          ? value.map((id) => String(id || "")).filter(Boolean)
          : [];
      } catch {
        return [];
      }
    },

    savePinnedSessions(sessionIds) {
      storage.setItem(storageKeys.pinnedSessions, JSON.stringify(sessionIds));
    },

    loadSessionModes(normalizeToolPermissionMode) {
      const stored = parseObject(storage, storageKeys.sessionModes);
      const modes = Object.fromEntries(Object.entries(stored).flatMap(
        ([sessionId, value]) => {
          const restored = restoreSessionMode(value, normalizeToolPermissionMode);
          return restored ? [[sessionId, restored]] : [];
        },
      ));
      storage.setItem(storageKeys.sessionModes, JSON.stringify(modes));
      return modes;
    },

    saveSessionModes(modes) {
      storage.setItem(storageKeys.sessionModes, JSON.stringify(modes));
    },

    loadLastToolPermissionMode(normalizeToolPermissionMode) {
      try {
        return normalizeToolPermissionMode(storage.getItem(storageKeys.lastToolPermissionMode));
      } catch {
        return "full_access";
      }
    },

    saveLastToolPermissionMode(mode) {
      storage.setItem(storageKeys.lastToolPermissionMode, mode);
    },

    loadModelPreferences() {
      return {
        sessionModels: parseObject(storage, storageKeys.sessionModels),
        lastModelByEnvironment: parseObject(
          storage,
          storageKeys.lastModelByEnvironment,
        ),
      };
    },

    saveModelPreferences(sessionModels, lastModelByEnvironment) {
      storage.setItem(storageKeys.sessionModels, JSON.stringify(sessionModels));
      storage.setItem(
        storageKeys.lastModelByEnvironment,
        JSON.stringify(lastModelByEnvironment),
      );
    },

    environmentId() {
      return String(storage.getItem(storageKeys.environmentId) || "").trim();
    },

    saveEnvironmentId(environmentId) {
      if (environmentId)
        storage.setItem(storageKeys.environmentId, environmentId);
      else storage.removeItem(storageKeys.environmentId);
    },

    sessionIdForEnvironment(environmentId) {
      return String(
        parseObject(storage, storageKeys.currentSessionByEnvironment)[
          environmentId
        ] || "",
      );
    },

    saveSessionIdForEnvironment(environmentId, sessionId) {
      const sessions = parseObject(
        storage,
        storageKeys.currentSessionByEnvironment,
      );
      if (sessionId) sessions[environmentId] = sessionId;
      else delete sessions[environmentId];
      storage.setItem(
        storageKeys.currentSessionByEnvironment,
        JSON.stringify(sessions),
      );
    },
  };
}
