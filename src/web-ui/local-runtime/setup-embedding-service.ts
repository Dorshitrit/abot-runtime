import type { ModelProviderAdapterRegistry } from "../../model-gateway/index.js";
import { createLocalLongTermMemoryOnboardingService } from "../../runtime/adapters/long-term-memory/onboarding-service.js";
import { parseSetupEmbeddingInput } from "./setup-embedding-input.js";
import {
  prepareSetupEmbeddingProvider,
  type SavedEmbeddingProvider,
} from "./setup-embedding-provider.js";
import { RuntimeSetupError } from "./runtime-setup-input.js";

export class SetupEmbeddingFailure extends Error {
  readonly code = "embedding_setup_failed";
  constructor(
    readonly providerSaved: boolean,
    readonly statusCode: number,
    message: string,
    readonly savedProvider?: SavedEmbeddingProvider,
  ) {
    super(message);
  }
}

export class SetupEmbeddingService {
  constructor(
    private readonly options: {
      rootDir: string;
      getConfigPath: () => string | undefined;
      providerAdapters: ModelProviderAdapterRegistry;
    },
  ) {}

  async enable(body: Record<string, unknown>, abortSignal: AbortSignal) {
    const input = parseSetupEmbeddingInput(body);
    abortSignal.throwIfAborted();
    const options = {
      rootDir: this.options.rootDir,
      configPath: this.options.getConfigPath(),
    };
    let savedProvider: SavedEmbeddingProvider | undefined;
    try {
      const prepared = await prepareSetupEmbeddingProvider(options, input);
      savedProvider = prepared.savedProvider;
      abortSignal.throwIfAborted();
      const service = createLocalLongTermMemoryOnboardingService({
        ...options,
        providerAdapters: this.options.providerAdapters,
      });
      const result = await service.enable({
        providerId: prepared.providerId,
        model: input.model,
        abortSignal,
      });
      return {
        status: result.status,
        probe: result.probe,
        restartRequired: true,
      };
    } catch (error) {
      if (error instanceof RuntimeSetupError) throw error;
      const providerSaved = savedProvider !== undefined;
      const message = providerSaved
        ? "The provider connection is saved, but the embedding check or memory save failed. Memory settings were not changed. Check the model and try again, or skip this step."
        : "The embedding connection could not be completed. Completed local settings were kept; memory settings were not changed.";
      throw new SetupEmbeddingFailure(
        providerSaved,
        400,
        message,
        savedProvider,
      );
    }
  }
}
