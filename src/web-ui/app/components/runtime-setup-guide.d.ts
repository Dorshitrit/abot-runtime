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

export interface RuntimeSetupGuideDependencies {
  readonly container: HTMLElement;
  readonly conversationRegion: HTMLElement;
  readonly copyText?: (value: string) => void | Promise<void>;
  readonly getSetupCommandMode?: () => "source" | "package" | undefined;
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
  focusAction(): void;
  render(setup: Record<string, unknown>): void;
};
