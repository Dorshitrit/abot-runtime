import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { LearningChangedEvent, PassiveLearningModel, PassiveLearningPreferences, ProactiveStatus, LearningReassessmentStatus } from "./contracts.js";
import type { CoWorkerResourceUsage } from "./resources/contracts.js";

export type LearningBackgroundContext = Readonly<{
  preferences(): PassiveLearningPreferences;
  assertProcessingAllowed(): void;
  changed(event?: LearningChangedEvent): void;
  isInteractiveBusy(): boolean;
  isStarted(): boolean;
  isProcessingBusy?(): boolean;
}>;

export type LearningProactiveLifecycle = Readonly<{
  start(): Promise<void>;
  stop(): Promise<void>;
  preferencesChanged(): Promise<void>;
  knowledgeChanged(): void;
  beginInteractive(): () => void;
  status(): Promise<ProactiveStatus>;
  dismiss(id: string): Promise<void>;
  sessionDeleted?(sessionId: string): Promise<void>;
}>;

export type LearningReassessmentLifecycle = Readonly<{
  start(): Promise<void>;
  stop(): Promise<void>;
  preferencesChanged(): Promise<void>;
  knowledgeChanged(): void;
  beginInteractive(): () => void;
  status(): LearningReassessmentStatus;
}>;

export type LearningBackgroundDependencies = Readonly<{
  model: PassiveLearningModel;
  memory: LongTermMemoryService;
  resourceUsage?(): Promise<CoWorkerResourceUsage & { activeCalls: number }>;
  proactive?: LearningProactiveLifecycle;
  reassessment?: LearningReassessmentLifecycle;
}>;
