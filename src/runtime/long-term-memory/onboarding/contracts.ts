import type { RuntimeConfigFile } from "../../config/types.js";

export type LongTermMemoryOnboardingProvider = Readonly<{
  id: string;
  type: string;
}>;

export type LongTermMemoryOnboardingStatus = Readonly<{
  enabled: boolean;
  emitClientEvents: boolean;
  profileId?: string;
  providerId?: string;
  model?: string;
  providers: readonly LongTermMemoryOnboardingProvider[];
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
  disable(): Promise<LongTermMemoryOnboardingResult>;
}>;
