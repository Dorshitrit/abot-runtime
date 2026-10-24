import { availableEmbeddingProviders } from "./onboarding-provider-availability.js";
import {
  discoverEmbeddingModels,
  executeEmbeddingRequest,
  type ModelProviderAdapterRegistry,
} from "../../../model-gateway/index.js";
import type {
  LongTermMemoryOnboardingConfigRepository,
  LongTermMemoryOnboardingService,
  LongTermMemoryOnboardingStatus,
} from "../../long-term-memory/onboarding/contracts.js";
import { createLongTermMemoryOnboardingService } from "../../long-term-memory/onboarding/service.js";
import { createFileLongTermMemoryOnboardingConfigRepository } from "./onboarding-config-repository.js";

const EMBEDDING_PROBE_TEXT =
  "ABot long-term memory embedding capability probe.";

export function createLocalLongTermMemoryOnboardingService(params: {
  rootDir: string;
  providerAdapters: ModelProviderAdapterRegistry;
  configPath?: string;
  fetchImpl?: typeof fetch;
  repository?: LongTermMemoryOnboardingConfigRepository;
}): LongTermMemoryOnboardingService {
  const repository =
    params.repository ??
    createFileLongTermMemoryOnboardingConfigRepository({
      rootDir: params.rootDir,
      ...(params.configPath ? { configPath: params.configPath } : {}),
    });
  const service = createLongTermMemoryOnboardingService({
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
  const projectStatus = (status: LongTermMemoryOnboardingStatus) => Object.freeze({
    ...status, providers: availableEmbeddingProviders(status.providers, params.providerAdapters),
  });
  return Object.freeze({
    ...service,
    async enable(input) {
      const result = await service.enable(input);
      return { ...result, status: projectStatus(result.status) };
    },
    async saveProfile(input) {
      const result = await service.saveProfile(input);
      return { ...result, status: projectStatus(result.status) };
    },
    async removeProfile(input) {
      const result = await service.removeProfile(input);
      return { ...result, status: projectStatus(result.status) };
    },
    async disable() {
      const result = await service.disable();
      return { ...result, status: projectStatus(result.status) };
    },
    async status() {
      const status = await service.status();
      return projectStatus(status);
    },
  });
}
