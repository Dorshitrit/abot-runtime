import type { ChatgptAccountRequests } from "../../services/runtime-web-client/chatgpt-accounts.js";
import type { ModelSetupInput } from "../../../local-runtime/model-setup-input.js";

export type AddedModelIdentity = Readonly<{
  profileId: string;
  providerId: string;
  provider: string;
  model: string;
}>;
export type ModelSetupProvider = Readonly<{
  id: string;
  type: string;
  accountRef?: string;
  authentication?: "chatgpt";
  label: string;
  requiresApiKey: boolean;
  credentialConfigured: boolean;
}>;
export interface ModelSetupWizardDependencies {
  root: HTMLElement;
  getEnvironmentId?: () => string;
  chatgptClient?: ChatgptAccountRequests;
  inspectConnection?: (input: Record<string, unknown>) => Promise<{ connection: { models: readonly string[] } }>;
  loadSetup: () => Promise<{
    providers: readonly ModelSetupProvider[];
    profileIds: readonly string[];
    defaultContextWindowTokens: number;
  }>;
  saveModel: (
    input: ModelSetupInput,
  ) => Promise<{ model: AddedModelIdentity; restartRequired: boolean }>;
  applySetup: () => Promise<{
    activation: { status: "ready" | "restart_required"; message?: string };
  }>;
  beginRuntimeMutation?: (subject?: string) => boolean;
  endRuntimeMutation?: () => void;
  onSaved?: (model: AddedModelIdentity) => void;
  onDeferred?: (model: AddedModelIdentity) => Promise<boolean>;
  onComplete?: (model: AddedModelIdentity) => Promise<boolean>;
  onClosed?: (result: { completed: boolean }) => void;
}
export declare function createModelSetupWizard(
  dependencies: ModelSetupWizardDependencies,
): {
  open(options?: { providerId?: string }): Promise<boolean>;
  close(): boolean;
  isOpen(): boolean;
  isBusy(): boolean;
  dispose(): void;
};
