import type { SetupEmbeddingInput } from "../../local-runtime/setup-embedding-input.js";

export type RuntimeSetupValidation = Readonly<{
  valid: boolean;
  value: string;
  message: string;
}>;
export type RuntimeSetupCommands = Readonly<{
  "ollama-pull": string;
  setup: string;
  "model-gateway": string;
  "web-ui": string;
}>;
export type RuntimeSetupProvider = Readonly<{
  id: "openai" | "ollama";
  label: string;
  requiresApiKey: boolean;
  credentialConfigured: boolean;
}>;
export type RuntimeSetupSnapshot = Readonly<{
  status: "required" | "ready";
  providers: readonly RuntimeSetupProvider[];
  configExists: boolean;
  recovery?: "configuration";
  message?: string;
  defaultContextWindowTokens: number;
  editableConnection?: { revision: string };
  existingModel?: {
    provider: "openai" | "ollama";
    model: string;
    contextWindowTokens?: number;
    baseUrl?: string;
  };
}>;
export type RuntimeSetupInput = {
  provider: "openai" | "ollama";
  model: string;
  contextWindowTokens?: number;
  baseUrl?: string;
  apiKey?: string;
  deferActivation?: boolean;
  connectionRevision?: string;
};
export type RuntimeSetupResponse = {
  setup: RuntimeSetupSnapshot;
  activation: { status: "ready" | "restart_required"; message?: string };
  embeddingInvalidated?: boolean;
};
export interface RuntimeSetupGuideDependencies {
  readonly container: HTMLElement;
  readonly conversationRegion: HTMLElement;
  readonly loadSetup: () => Promise<{ setup: RuntimeSetupSnapshot }>;
  readonly applySetup: () => Promise<{
    activation: RuntimeSetupResponse["activation"];
  }>;
  readonly saveSetup: (
    input: RuntimeSetupInput,
  ) => Promise<RuntimeSetupResponse>;
  readonly loadEmbeddingStatus: () => Promise<Record<string, unknown>>;
  readonly discoverEmbeddingModels: (
    providerId: string,
  ) => Promise<Record<string, unknown>>;
  readonly saveEmbedding: (
    input: SetupEmbeddingInput,
  ) => Promise<Record<string, unknown>>;
  readonly loadPlugins: () => Promise<Record<string, unknown>>;
  readonly setPlugin: (input: {
    pluginId: string;
    capabilityId?: string;
    enabled: boolean;
  }) => Promise<Record<string, unknown>>;
  readonly getEnvironmentId?: () => string;
  readonly loadHostConnection?: () => Promise<Record<string, unknown>>;
  readonly downloadHostSetup?: (
    platform: "windows" | "macos",
  ) => Promise<Record<string, unknown>>;
  readonly revokeHostConnection?: () => Promise<Record<string, unknown>>;
  readonly openConfiguration?: () => void;
}
export declare function validateRuntimeSetupModelId(
  value: unknown,
): RuntimeSetupValidation;
export declare function validateRuntimeSetupBaseUrl(
  value: unknown,
): RuntimeSetupValidation;
export declare function buildRuntimeSetupCommands(
  provider: unknown,
  modelId: unknown,
  ollamaBaseUrl?: unknown,
  setupCommandMode?: "source" | "package",
): RuntimeSetupCommands;
export declare function createRuntimeSetupGuide(
  options: RuntimeSetupGuideDependencies,
): {
  bind(options?: { onCheckAgain?: () => void | Promise<void> }): void;
  clearSecret(): void;
  dispose(): void;
  focusAction(): void;
  render(setup: Record<string, unknown>): void;
};
