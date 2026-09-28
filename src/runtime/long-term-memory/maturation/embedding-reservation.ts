import type { LongTermMemoryEmbeddingClient } from "../contracts.js";
import type { LearningEmbeddingReservation } from "./contracts.js";

export function reserveLearningEmbeddings(client: LongTermMemoryEmbeddingClient, reserve?: LearningEmbeddingReservation): LongTermMemoryEmbeddingClient {
  if (!reserve) return client;
  return {
    ...client,
    async embed(input) {
      const release = await reserve({ characters: input.texts.reduce((sum, text) => sum + text.length, 0), signal: input.abortSignal });
      try {
        input.abortSignal.throwIfAborted();
        return await client.embed(input);
      } finally { release(); }
    },
  };
}
