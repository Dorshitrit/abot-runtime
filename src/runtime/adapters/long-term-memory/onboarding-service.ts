import {
  discoverEmbeddingModels,
  executeEmbeddingRequest,
  type ModelProviderAdapterRegistry,
} from "../../../model-gateway/index.js";
import type { LongTermMemoryOnboardingService } from "../../long-term-memory/onboarding/contracts.js";
import { createLongTermMemoryOnboardingService } from "../../long-term-memory/onboarding/service.js";
import { createFileLongTermMemoryOnboardingConfigRepository } from "./onboarding-config-repository.js";

const EMBEDDING_PROBE_TEXT =
  "ABot long-term memory embedding capability probe.";

export function createLocalLongTermMemoryOnboardingService(params: {
  rootDir: string;
  providerAdapters: ModelProviderAdapterRegistry;
  configPath?: string;
  fetchImpl?: typeof fetch;
}): LongTermMemoryOnboardingService {
  const repository = createFileLongTermMemoryOnboardingConfigRepository({
    rootDir: params.rootDir,
    ...(params.configPath ? { configPath: params.configPath } : {}),
  });
  return createLongTermMemoryOnboardingService({
    repository,
    probe: async (input) => {
      const result = await executeEmbeddingRequest({
        profileId: input.profileId,
        texts: [EMBEDDING_PROBE_TEXT],
        modelPolicy: input.modelPolicy,
        abortSignal: input.abortSignal,
        providerAdapters: params.providerAdapters,
        ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
      });
      return Object.freeze({
        modelFingerprint: result.modelFingerprint,
        dimensions: result.dimensions,
      });
    },
    discover: (input) =>
      discoverEmbeddingModels({
        providerId: input.providerId,
        modelPolicy: input.modelPolicy,
        abortSignal: input.abortSignal,
        providerAdapters: params.providerAdapters,
        ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
      }),
  });
}
