export type AgentMode = "auto" | "fast" | "reasoning" | "deep";
export type ToolPermissionMode = "ask" | "full_access";

export declare function normalizeAgentMode(mode: unknown): AgentMode;
export declare function normalizeToolPermissionMode(
  value: unknown,
): ToolPermissionMode;

export interface RuntimeSelectionOptionSurface {
  readonly value: string;
  readonly textContent: string | null;
}

export interface RuntimeSelectionOptionCollection extends Iterable<RuntimeSelectionOptionSurface> {
  readonly length: number;
  readonly [index: number]: RuntimeSelectionOptionSurface | undefined;
}

export interface RuntimeSelectionEnvironmentSelectSurface {
  value: string;
  innerHTML: string;
  readonly options: RuntimeSelectionOptionCollection;
  append(option: unknown): unknown;
}

export interface RuntimeSelectionModelSelectSurface {
  value: string;
  innerHTML: string;
  disabled: boolean;
  readonly options: RuntimeSelectionOptionCollection;
  appendChild(option: unknown): unknown;
}

export interface RuntimeSelectionClassListSurface {
  toggle(token: string, force?: boolean): unknown;
}

export interface RuntimeSelectionPickerButtonSurface {
  hidden: boolean;
  innerHTML: string;
  title: string;
  readonly classList: RuntimeSelectionClassListSurface;
  setAttribute(name: string, value: string): void;
}

export interface RuntimeSelectionControlButtonSurface {
  innerHTML: string;
  title: string;
  disabled: boolean;
  readonly classList: RuntimeSelectionClassListSurface;
  setAttribute(name: string, value: string): void;
  focus(): void;
}

export interface RuntimeSelectionAgentModeButtonSurface {
  innerHTML: string;
  disabled: boolean;
  readonly classList: RuntimeSelectionClassListSurface;
  setAttribute(name: string, value: string): void;
  focus(): void;
}

export interface RuntimeSelectionPickerMenuSurface {
  hidden: boolean;
  innerHTML: string;
  readonly classList: RuntimeSelectionClassListSurface;
}

export interface RuntimeSelectionControlMenuSurface extends RuntimeSelectionPickerMenuSurface {
  setAttribute(name: string, value: string): void;
  querySelectorAll(selector: string): Iterable<Element>;
}

export interface RuntimeSelectionControllerDependencies {
  readonly state: {
    config: Readonly<{
      environments?: readonly Readonly<{
        id?: unknown;
        label?: unknown;
      }>[];
      defaultEnvironmentId?: unknown;
    }> | null;
    pinnedSessionIds: readonly string[];
    sessionModes: Record<string, Record<string, unknown>>;
    sessionModels: Record<string, unknown>;
    lastModelByEnvironment: Record<string, unknown>;
    agentMode: AgentMode;
    supportedAgentModes: AgentMode[];
    agentModeMenuOpen: boolean;
    permissionModeMenuOpen: boolean;
    agentPickerOpen: boolean;
    modelProfiles: Array<
      Record<string, unknown> & {
        id: string;
        label?: string;
        provider?: string;
        supportsImageInput?: boolean;
        capabilities?: Readonly<{
          inputModalities?: readonly unknown[];
        }>;
      }
    >;
    defaultModelProfileId: string;
    currentSessionId: string;
  };
  readonly dom: Readonly<{
    environmentSelect: RuntimeSelectionEnvironmentSelectSurface;
    modelSelect: RuntimeSelectionModelSelectSurface;
    agentPickerButton: RuntimeSelectionPickerButtonSurface;
    agentPickerMenu: RuntimeSelectionPickerMenuSurface;
    permissionModeButton: RuntimeSelectionControlButtonSurface;
    permissionModeMenu: RuntimeSelectionControlMenuSurface;
    agentModeButton: RuntimeSelectionAgentModeButtonSurface;
    agentModeMenu: RuntimeSelectionControlMenuSurface;
  }>;
  readonly preferences: Readonly<{
    loadPinnedSessions(): string[];
    loadSessionModes(
      normalize: (value: unknown) => ToolPermissionMode,
    ): Record<string, Record<string, unknown>>;
    saveSessionModes(modes: Record<string, Record<string, unknown>>): void;
    loadModelPreferences(): {
      sessionModels: Record<string, unknown>;
      lastModelByEnvironment: Record<string, unknown>;
    };
    saveModelPreferences(
      sessionModels: Record<string, unknown>,
      lastModelByEnvironment: Record<string, unknown>,
    ): void;
  }>;
  readonly modelSelector: Readonly<{
    sync(): void;
  }>;
  readonly client: Readonly<{
    getAgentMode(environmentId: string): Promise<Record<string, unknown>>;
    setAgentMode(
      mode: AgentMode,
      environmentId: string,
    ): Promise<Record<string, unknown>>;
    listModels(environmentId: string): Promise<Record<string, unknown>>;
  }>;
  readonly recordControlEvent: (event: {
    type: "control";
    name: string;
    tone: "failed";
    summary: string;
  }) => void;
  readonly onAttachmentPolicyChange: () => void;
  readonly getComposerSessionId?: () => string;
  readonly onModelCatalogLoading?: () => void;
  readonly onModelCatalogLoaded?: (payload: Record<string, unknown>) => void;
  readonly onModelCatalogUnavailable?: (error: unknown) => void;
}

export declare function createRuntimeSelectionController(
  options: RuntimeSelectionControllerDependencies,
): {
  applyModelSelection(): void;
  clearSessionMode(sessionId: string): void;
  configuredEnvironmentOptions(): Array<{ value: string; label: string }>;
  currentToolPermissionMode(): ToolPermissionMode;
  environmentOptions(): Array<{ value: string; label: string }>;
  loadAgentMode(): Promise<boolean>;
  loadModels(): Promise<boolean>;
  loadPreferences(): void;
  rememberModelSelection(): void;
  renderAgentMode(): void;
  renderAgentPicker(): void;
  renderEnvironmentOptions(): void;
  renderModels(): void;
  renderPermissionMode(): void;
  saveModelPreferences(): void;
  selectedEnvironmentId(): string;
  selectedModelPreference(): Record<string, unknown> | null;
  selectedModelSupportsImageInput(profileId?: string): boolean;
  setAgentMode(mode: AgentMode): Promise<boolean>;
  setToolPermissionMode(mode: ToolPermissionMode): void;
};
