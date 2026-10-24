import type { SetupEmbeddingInput } from "../../../local-runtime/setup-embedding-input.js";

export type MemoryEmbeddingOptions = Readonly<{
  profileId?: string;
  emitClientEvents?: boolean;
}>;
export type MemoryEmbeddingDialogDependencies = {
  root: HTMLElement;
  getEnvironmentId?: () => string;
  loadStatus: (environmentId: string) => Promise<Record<string, any>>;
  saveConnection: (
    input: SetupEmbeddingInput,
    memory: MemoryEmbeddingOptions,
    environmentId: string,
  ) => Promise<Record<string, any>>;
  discoverModels: (
    providerId: string,
    environmentId: string,
  ) => Promise<Record<string, any>>;
  beginRuntimeMutation?: (environmentId: string) => boolean;
  endRuntimeMutation?: (environmentId: string) => void;
  refreshRuntimeConfig?: (environmentId: string) => Promise<boolean>;
  onSaved?: (payload: Record<string, any>, environmentId: string) => void;
  onApplied?: (
    payload: Record<string, any>,
    environmentId: string,
  ) => Promise<unknown>;
  applyConfiguration: (environmentId: string) => Promise<Record<string, any>>;
  onClosed?: (result: { completed: boolean }) => void;
};
export function createMemoryEmbeddingConnectionDialog(
  dependencies: MemoryEmbeddingDialogDependencies,
): {
  open(options?: MemoryEmbeddingOptions): Promise<boolean>;
  close(): boolean;
  isOpen(): boolean;
  environmentChanged(): void;
};
