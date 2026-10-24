import type { ModelProviderAdapterRegistry } from "../../model-gateway/index.js";
import { createLocalLongTermMemoryOnboardingService } from "../../runtime/adapters/long-term-memory/onboarding-service.js";
import { parseMemoryEmbeddingConnectionInput } from "./memory-embedding-connection-input.js";
import {
  prepareSetupEmbeddingProvider,
  type SavedEmbeddingProvider,
} from "./setup-embedding-provider.js";
import { SetupEmbeddingFailure } from "./setup-embedding-service.js";
import { RuntimeSetupError } from "./runtime-setup-input.js";

/** Adds an embedding connection without applying onboarding's plugin policy. */
export class MemoryEmbeddingConnectionService {
  constructor(
    private readonly options: {
      rootDir: string;
      getConfigPath: () => string | undefined;
      providerAdapters: ModelProviderAdapterRegistry;
    },
  ) {}

  async enable(body: Record<string, unknown>, abortSignal: AbortSignal) {
    const input = parseMemoryEmbeddingConnectionInput(body);
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
      const current = await service.status();
      return await service.enable({
        providerId: prepared.providerId,
        model: input.model,
        profileId: input.profileId ?? current.profileId,
        emitClientEvents: input.emitClientEvents ?? current.emitClientEvents,
        abortSignal,
      });
    } catch (error) {
      if (error instanceof RuntimeSetupError) throw error;
      const providerSaved = savedProvider !== undefined;
      const message = providerSaved
        ? "The provider connection is saved, but the embedding check or memory save failed. Memory settings were not changed. Check the model and try again."
        : "The embedding connection could not be saved. Memory settings were not changed.";
      throw new SetupEmbeddingFailure(
        providerSaved,
        400,
        message,
        savedProvider,
      );
    }
  }
}
