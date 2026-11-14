import type { ToolPermissionMode, RuntimeConfig, SessionStore } from "../ports.js";
import type { PassiveLearningService } from "../passive-learning/contracts.js";

export const SPARK_CHAT_FEATURE = "spark_chat_v1";

export type SparkChatState = Readonly<{
  sessionId: string;
  modelProfileId: string | null;
  toolPermissionMode: ToolPermissionMode;
  readiness: "ready" | "model_required" | "model_unavailable";
}>;

export type SparkChatAccess = Readonly<{
  open(): Promise<SparkChatState>;
  resolve<T extends object>(
    sessionId: string,
    body: T,
    options?: Readonly<{ requireMatchingPermissionMode?: boolean }>,
  ): Promise<T>;
}>;

export type SparkChatServices = Readonly<{
  sessions: Pick<SessionStore, "getSessionById" | "getOrCreateSession">;
  config: Pick<RuntimeConfig, "models">;
  passiveLearning: Pick<PassiveLearningService, "status">;
}>;
