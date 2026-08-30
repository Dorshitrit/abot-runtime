export type RuntimeAvailability = Record<string, unknown> & {
  status: string;
  message?: string;
  showGuide?: boolean;
};

export interface RuntimeOnboardingControllerDependencies {
  readonly state: {
    runtimeAvailability: RuntimeAvailability;
  };
  readonly guide: Readonly<{
    bind(options?: { onCheckAgain?: () => void | Promise<void> }): void;
    focusAction(): void;
    render(setup: RuntimeAvailability): void;
  }>;
  readonly reloadModels: () => void | Promise<void>;
  readonly setMessageStatus: (message: string) => void;
  readonly onStateChange?: () => void;
}

export declare function createRuntimeOnboardingController(
  options: RuntimeOnboardingControllerDependencies,
): {
  applyCatalog(payload: Record<string, unknown>): void;
  beginCatalogLoad(): void;
  bind(): void;
  catalogUnavailable(error: unknown): void;
  isReady(): boolean;
  presentSubmissionBlock(block: { message?: string } | null): void;
  render(): void;
  submissionBlock(): { code: string; message: string } | null;
};
