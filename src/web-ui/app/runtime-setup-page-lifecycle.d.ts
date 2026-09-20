export declare function bindRuntimeSetupPageLifecycle(options: {
  readonly page: Pick<Window, "addEventListener">;
  readonly dispose: () => void;
  readonly reloadModels: () => void | Promise<void>;
}): void;
