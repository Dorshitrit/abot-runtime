import type { RuntimeConfigFile } from "../../config/types.js";

export type LongTermMemoryOnboardingProvider = Readonly<{
  id: string;
  type: string;
}>;

export type SavedMemoryEmbeddingProfile = Readonly<{
  id: string;
  label: string;
  providerId: string;
  model: string;
}>;

export type LongTermMemoryEmbeddingProfileSaveResult = Readonly<{
  status: LongTermMemoryOnboardingStatus;
  profileId: string;
  configPath: string;
  backupPath?: string;
}>;

export type LongTermMemoryEmbeddingProfileRemoveResult =
  LongTermMemoryEmbeddingProfileSaveResult & Readonly<{ removed: true }>;

export type LongTermMemoryOnboardingStatus = Readonly<{
  enabled: boolean;
  emitClientEvents: boolean;
  profileId?: string;
  providerId?: string;
  model?: string;
  providers: readonly LongTermMemoryOnboardingProvider[];
  embeddingProfiles: readonly SavedMemoryEmbeddingProfile[];
}>;

export type LongTermMemoryOnboardingResult = Readonly<{
  status: LongTermMemoryOnboardingStatus;
  restartRequired: boolean;
  configPath: string;
  backupPath?: string;
  probe?: Readonly<{
    modelFingerprint: string;
    dimensions: number;
  }>;
}>;

export type LongTermMemoryOnboardingConfigSnapshot = Readonly<{
  config: RuntimeConfigFile;
  path: string;
}>;

export type LongTermMemoryOnboardingConfigRepository = Readonly<{
  read(): Promise<LongTermMemoryOnboardingConfigSnapshot>;
  write(
    config: RuntimeConfigFile,
    expectedConfig?: RuntimeConfigFile,
  ): Promise<Readonly<{ configPath: string; backupPath?: string }>>;
}>;

export type LongTermMemoryOnboardingService = Readonly<{
  status(): Promise<LongTermMemoryOnboardingStatus>;
  discover(
    input: Readonly<{
      providerId: string;
      abortSignal?: AbortSignal;
    }>,
  ): Promise<Readonly<{ supported: boolean; models: readonly string[] }>>;
  enable(
    input: Readonly<{
      providerId: string;
      model: string;
      profileId?: string;
      emitClientEvents?: boolean;
      abortSignal?: AbortSignal;
    }>,
  ): Promise<LongTermMemoryOnboardingResult>;
  saveProfile(input: Readonly<{
    providerId: string;
    model: string;
    label: string;
    abortSignal?: AbortSignal;
  }>): Promise<LongTermMemoryEmbeddingProfileSaveResult>;
  removeProfile(input: Readonly<{
    profileId: string;
    abortSignal?: AbortSignal;
  }>): Promise<LongTermMemoryEmbeddingProfileRemoveResult>;
  disable(): Promise<LongTermMemoryOnboardingResult>;
}>;
