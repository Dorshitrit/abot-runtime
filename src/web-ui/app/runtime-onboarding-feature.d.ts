import type { createRuntimeSetupGuide } from "./components/runtime-setup-guide.js";
import type {
  createRuntimeOnboardingController,
  RuntimeAvailability,
} from "./controllers/runtime-onboarding-controller.js";
import type { createRuntimeWebClient } from "./services/runtime-web-client.js";

export declare function createRuntimeOnboardingFeature(options: {
  dom: { runtimeSetupGuide: HTMLElement; messagesList: HTMLElement };
  runtimeClient: Pick<
    ReturnType<typeof createRuntimeWebClient>,
    | "getRuntimeSetup"
    | "saveRuntimeSetup"
    | "applyRuntimeConfiguration"
    | "loadLongTermMemoryStatus"
    | "loadModelSetup"
    | "discoverLongTermMemoryModels"
    | "saveRuntimeSetupEmbedding"
    | "getRuntimePlugins"
    | "setRuntimePlugin"
  >;
  selectedEnvironmentId(): string;
  state: {
    config: Record<string, unknown> | null;
    runtimeAvailability: RuntimeAvailability;
  };
  reloadModels(): unknown | Promise<unknown>;
  reloadCatalog(): unknown | Promise<unknown>;
  setMessageStatus(message: string): void;
  onStateChange?(): void;
}): {
  guide: ReturnType<typeof createRuntimeSetupGuide>;
  controller: ReturnType<typeof createRuntimeOnboardingController>;
};
