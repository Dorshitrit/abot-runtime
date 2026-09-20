import type { createRuntimeWebClient } from "../../services/runtime-web-client.js";

type RuntimeClient = ReturnType<typeof createRuntimeWebClient>;
export declare function createEmbeddingCredentialStatus(options: {
  runtimeClient: Pick<
    RuntimeClient,
    "loadLongTermMemoryStatus" | "saveRuntimeSetupEmbedding" | "loadModelSetup"
  >;
  getEnvironmentId(): string;
}): {
  loadStatus(): Promise<Record<string, unknown>>;
  saveEmbedding(
    input: Parameters<RuntimeClient["saveRuntimeSetupEmbedding"]>[0],
  ): Promise<Record<string, unknown>>;
};
