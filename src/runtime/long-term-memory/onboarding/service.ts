import { buildRemovedEmbeddingProfile, buildSavedEmbeddingProfile } from "./saved-profiles.js";
import type { ModelGatewayPolicyConfig } from "../../../model-gateway/types.js";
import { buildModelConfig } from "../../config/builders.js";
import { validateRuntimeConfigFile } from "../../config/validation.js";
import {
  buildDisabledMemoryConfig,
  buildEnabledMemoryConfig,
  projectOnboardingStatus,
  requireConfiguredProvider,
} from "./configuration.js";
import type {
  LongTermMemoryOnboardingConfigRepository,
  LongTermMemoryOnboardingService,
} from "./contracts.js";

import { readEmbeddingProfileId } from "./embedding-profile-id.js";

export function createLongTermMemoryOnboardingService(dependencies: {
  repository: LongTermMemoryOnboardingConfigRepository;
  probe(
    input: Readonly<{
      profileId: string;
      modelPolicy: ModelGatewayPolicyConfig;
      abortSignal: AbortSignal;
    }>,
  ): Promise<Readonly<{ modelFingerprint: string; dimensions: number }>>;
  discover(
    input: Readonly<{
      providerId: string;
      modelPolicy: ModelGatewayPolicyConfig;
      abortSignal: AbortSignal;
    }>,
  ): Promise<Readonly<{ supported: boolean; models: readonly string[] }>>;
}): LongTermMemoryOnboardingService {
  return Object.freeze({
    async status() {
      const snapshot = await dependencies.repository.read();
      return projectOnboardingStatus(snapshot.config);
    },
    async discover(input) {
      const snapshot = await dependencies.repository.read();
      const providerId = requireText(input.providerId, "providerId");
      const abortSignal = input.abortSignal ?? new AbortController().signal;
      abortSignal.throwIfAborted();
      requireConfiguredProvider(snapshot.config, providerId);
      return dependencies.discover({
        providerId,
        modelPolicy: requireModelPolicy(snapshot.config, snapshot.path),
        abortSignal,
      });
    },
    async enable(input) {
      const snapshot = await dependencies.repository.read();
      const providerId = requireText(input.providerId, "providerId");
      const model = requireText(input.model, "model");
      const profileId = readEmbeddingProfileId(input.profileId);
      const abortSignal = input.abortSignal ?? new AbortController().signal;
      abortSignal.throwIfAborted();
      requireConfiguredProvider(snapshot.config, providerId);
      const candidate = buildEnabledMemoryConfig({
        config: snapshot.config,
        providerId,
        model,
        profileId,
        emitClientEvents: input.emitClientEvents === true,
      });
      validateRuntimeConfigFile(candidate, snapshot.path);
      const probe = await dependencies.probe({
        profileId,
        modelPolicy: requireModelPolicy(candidate, snapshot.path),
        abortSignal,
      });
      abortSignal.throwIfAborted();
      const persisted = await dependencies.repository.write(
        candidate,
        snapshot.config,
      );
      return Object.freeze({
        status: projectOnboardingStatus(candidate),
        restartRequired: true,
        configPath: persisted.configPath,
        ...(persisted.backupPath ? { backupPath: persisted.backupPath } : {}),
        probe: Object.freeze({ ...probe }),
      });
    },
    async saveProfile(input) {
      const snapshot = await dependencies.repository.read();
      const providerId = requireText(input.providerId, "providerId");
      const model = requireText(input.model, "model");
      const label = requireText(input.label, "profile_label");
      const abortSignal = input.abortSignal ?? new AbortController().signal;
      abortSignal.throwIfAborted();
      requireConfiguredProvider(snapshot.config, providerId);
      const candidate = buildSavedEmbeddingProfile({ config: snapshot.config, providerId, model, label });
      validateRuntimeConfigFile(candidate.config, snapshot.path);
      abortSignal.throwIfAborted();
      const persisted = await dependencies.repository.write(candidate.config, snapshot.config);
      return Object.freeze({
        status: projectOnboardingStatus(candidate.config),
        profileId: candidate.profileId,
        configPath: persisted.configPath,
        ...(persisted.backupPath ? { backupPath: persisted.backupPath } : {}),
      });
    },
    async removeProfile(input) {
      const snapshot = await dependencies.repository.read();
      const profileId = requireText(input.profileId, "profileId");
      const abortSignal = input.abortSignal ?? new AbortController().signal;
      abortSignal.throwIfAborted();
      const candidate = buildRemovedEmbeddingProfile(snapshot.config, profileId);
      validateRuntimeConfigFile(candidate, snapshot.path);
      abortSignal.throwIfAborted();
      const persisted = await dependencies.repository.write(candidate, snapshot.config);
      return Object.freeze({
        removed: true as const,
        status: projectOnboardingStatus(candidate),
        profileId,
        configPath: persisted.configPath,
        ...(persisted.backupPath ? { backupPath: persisted.backupPath } : {}),
      });
    },
    async disable() {
      const snapshot = await dependencies.repository.read();
      const candidate = buildDisabledMemoryConfig(snapshot.config);
      validateRuntimeConfigFile(candidate, snapshot.path);
      const persisted = await dependencies.repository.write(
        candidate,
        snapshot.config,
      );
      return Object.freeze({
        status: projectOnboardingStatus(candidate),
        restartRequired: true,
        configPath: persisted.configPath,
        ...(persisted.backupPath ? { backupPath: persisted.backupPath } : {}),
      });
    },
  });
}

function requireModelPolicy(
  config: Parameters<typeof buildModelConfig>[0],
  configPath: string,
): ModelGatewayPolicyConfig {
  const modelPolicy = buildModelConfig(config, { mainConfigPath: configPath });
  if (!modelPolicy) {
    throw new Error("long_term_memory_model_policy_required");
  }
  return modelPolicy;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`long_term_memory_${field}_required`);
  }
  return normalized;
}
