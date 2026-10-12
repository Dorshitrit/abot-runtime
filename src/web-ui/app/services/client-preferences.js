import { createSessionSidebarPreferences } from "./session-sidebar-preferences.js";

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
      ? Object.assign(Object.create(null), value)
      : Object.create(null);
  } catch {
    return Object.create(null);
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
    subscribe: (listener) => storage.subscribe?.(listener),
    flush: () => storage.flush?.(),
    ...createSessionSidebarPreferences(storage),
    loadPinnedSessions() {
      try {
        const acknowledged = storage.snapshot?.();
        const raw = acknowledged
          ? acknowledged.preferences[storageKeys.pinnedSessions]
          : storage.getItem(storageKeys.pinnedSessions);
        const value = raw ? JSON.parse(raw) : [];
        return Array.isArray(value)
          ? value.map((id) => String(id || "")).filter(Boolean)
          : [];
      } catch {
        return [];
      }
    },

    savePinnedSessions(sessionIds) {
      return storage.setItem(storageKeys.pinnedSessions, JSON.stringify(sessionIds));
    },

    loadSessionModes(normalizeToolPermissionMode) {
      const stored = parseObject(storage, storageKeys.sessionModes);
      const modes = Object.fromEntries(Object.entries(stored).flatMap(
        ([sessionId, value]) => {
          const restored = restoreSessionMode(value, normalizeToolPermissionMode);
          return restored ? [[sessionId, restored]] : [];
        },
      ));
      return Object.assign(Object.create(null), modes);
    },

    saveSessionModes(modes) {
      return storage.setItem(storageKeys.sessionModes, JSON.stringify(modes));
    },

    loadLastToolPermissionMode(normalizeToolPermissionMode) {
      try {
        const mode = storage.getItem(storageKeys.lastToolPermissionMode);
        if (!["ask", "full_access", "full_plus"].includes(mode)) return "ask";
        return normalizeToolPermissionMode(mode);
      } catch {
        return "ask";
      }
    },

    saveLastToolPermissionMode(mode) {
      return storage.setItem(storageKeys.lastToolPermissionMode, mode);
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
      const sessions = storage.setItem(storageKeys.sessionModels, JSON.stringify(sessionModels));
      const environments = storage.setItem(
        storageKeys.lastModelByEnvironment,
        JSON.stringify(lastModelByEnvironment),
      );
      const saved = Promise.all([sessions, environments]);
      void saved.catch(() => {});
      return saved;
    },

    environmentId() {
      return String(storage.getItem(storageKeys.environmentId) || "").trim();
    },

    saveEnvironmentId(environmentId) {
      if (environmentId)
        return storage.setItem(storageKeys.environmentId, environmentId);
      return storage.removeItem(storageKeys.environmentId);
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
      return storage.setItem(
        storageKeys.currentSessionByEnvironment,
        JSON.stringify(sessions),
      );
    },
  };
}
