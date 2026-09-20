import type { ToolPermissionMode } from "../lib/tool-permission-mode.js";

type PreferenceMap = Record<string, unknown>;
type SessionModeMap = Record<string, Record<string, unknown>>;

export declare function createClientPreferences(storage: Pick<
  Storage, "getItem" | "setItem" | "removeItem"
>): {
  loadPinnedSessions(): string[];
  savePinnedSessions(sessionIds: readonly string[]): void;
  loadSessionModes(normalize: (value: unknown) => ToolPermissionMode): SessionModeMap;
  saveSessionModes(modes: SessionModeMap): void;
  loadLastToolPermissionMode(normalize: (value: unknown) => ToolPermissionMode): ToolPermissionMode;
  saveLastToolPermissionMode(mode: ToolPermissionMode): void;
  loadModelPreferences(): {
    sessionModels: PreferenceMap;
    lastModelByEnvironment: PreferenceMap;
  };
  saveModelPreferences(sessionModels: PreferenceMap, lastModelByEnvironment: PreferenceMap): void;
  environmentId(): string;
  saveEnvironmentId(environmentId: string): void;
  sessionIdForEnvironment(environmentId: string): string;
  saveSessionIdForEnvironment(environmentId: string, sessionId: string): void;
};
