import type { ConversationReasoningPreferences } from "./conversation-reasoning-preferences.js";
import type { ToolPermissionMode } from "../lib/tool-permission-mode.js";

type PreferenceMap = Record<string, unknown>;
type SessionModeMap = Record<string, Record<string, unknown>>;
type SessionSidebarPreferences = {
  archivedSessionIds: string[];
  orderedSessionIds: string[];
};
type PreferenceStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void | Promise<unknown>;
  removeItem(key: string): void | Promise<unknown>;
  subscribe?(listener: () => void): () => void;
  flush?(): Promise<void>;
  snapshot?(): { preferences: Record<string, string> } | null;
};

export declare function createClientPreferences(storage: PreferenceStorage): ConversationReasoningPreferences & {
  subscribe(listener: () => void): (() => void) | undefined;
  flush(): Promise<void> | undefined;
  loadSessionSidebar(environmentId: string): SessionSidebarPreferences;
  saveSessionSidebar(environmentId: string, value: SessionSidebarPreferences): void | Promise<unknown>;
  loadCollapsedProjectIds(environmentId: string): string[];
  saveCollapsedProjectIds(environmentId: string, ids: readonly string[]): void | Promise<unknown>;
  loadPinnedSessions(): string[];
  savePinnedSessions(sessionIds: readonly string[]): void | Promise<unknown>;
  loadSessionModes(normalize: (value: unknown) => ToolPermissionMode): SessionModeMap;
  saveSessionModes(modes: SessionModeMap): void | Promise<unknown>;
  loadLastToolPermissionMode(normalize: (value: unknown) => ToolPermissionMode): ToolPermissionMode;
  saveLastToolPermissionMode(mode: ToolPermissionMode): void | Promise<unknown>;
  loadModelPreferences(): {
    sessionModels: PreferenceMap;
    lastModelByEnvironment: PreferenceMap;
  };
  saveModelPreferences(sessionModels: PreferenceMap, lastModelByEnvironment: PreferenceMap): Promise<unknown[]>;
  environmentId(): string;
  saveEnvironmentId(environmentId: string): void | Promise<unknown>;
  sessionIdForEnvironment(environmentId: string): string;
  saveSessionIdForEnvironment(environmentId: string, sessionId: string): void | Promise<unknown>;
};
