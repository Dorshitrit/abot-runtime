import type { ManagedLlamaClient } from "../../services/runtime-web-client/managed-llama.js";
import type { LaunchSettings } from "../../../managed-llama/contracts.js";

export type ManagedLlamaSelection = {
  managedLlama: true; model: string; baseUrl: string; contextWindowTokens: number;
};
export type ManagedLlamaViewState = {
  mode: string; modelPath: string; alias: string; port: string;
  contextTokens: string; gpuLayers: string;
  status: null | {
    supported: boolean; closed: boolean; phase: string; installation: string;
    ownsProcess: boolean; preferences: LaunchSettings | null; errorCode?: string;
  };
  capabilities: { release?: unknown } | null;
  busy: string; error: string; retry: string; ready: ManagedLlamaSelection | null;
};
export declare function createManagedLlamaBinding(dependencies: {
  client?: ManagedLlamaClient; getEnvironmentId?: () => string;
  onChange?: () => void; onReady?: (ready: ManagedLlamaSelection) => void | Promise<void>;
}): {
  readonly state: ManagedLlamaViewState;
  reset(options?: { notify?: boolean }): void;
  input(field: string, value: unknown): boolean | Promise<boolean>;
  action(name: string): Promise<boolean>;
  isBusy(): boolean;
};
export declare function renderManagedLlama(state: ManagedLlamaViewState, idPrefix?: string): string;
