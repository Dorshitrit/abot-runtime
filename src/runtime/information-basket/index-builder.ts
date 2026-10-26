import { setImmediate } from "node:timers/promises";
import type { ModelGatewayClient, RuntimeConfig } from "../ports.js";
import { InformationBasketError } from "./contracts.js";
import { chunkBasketText } from "./chunking.js";
import { embedBasketTexts } from "./embedding.js";
import type { BasketSourceIndex, BasketSourceReader, BasketIndexedChunk } from "./index-records.js";
import { BASKET_LIMITS } from "./limits.js";
import { basketProfileSignature } from "./profile-binding.js";

export async function buildBasketSourceIndex(params: {
  config: RuntimeConfig; models: Pick<ModelGatewayClient, "embed">;
  profileId: string; path: string; reader: BasketSourceReader; abortSignal: AbortSignal;
}): Promise<Readonly<{ index: BasketSourceIndex; sizeBytes: number }>> {
  const document = await params.reader(params.path, params.abortSignal);
  const chunks = chunkBasketText(document.text);
  const vectors: BasketIndexedChunk[] = [];
  let modelFingerprint: string | undefined;
  let dimensions: number | undefined;
  for (let offset = 0; offset < chunks.length; offset += BASKET_LIMITS.embeddingBatchSize) {
    params.abortSignal.throwIfAborted();
    const batch = chunks.slice(offset, offset + BASKET_LIMITS.embeddingBatchSize);
    const embedded = await embedBasketTexts({ ...params, texts: batch.map(chunk => chunk.text) });
    if (modelFingerprint !== undefined && modelFingerprint !== embedded.modelFingerprint)
      throw new InformationBasketError("basket_embedding_binding_changed");
    if (dimensions !== undefined && dimensions !== embedded.dimensions)
      throw new InformationBasketError("basket_embedding_binding_changed");
    modelFingerprint = embedded.modelFingerprint;
    dimensions = embedded.dimensions;
    vectors.push(...batch.map((chunk, i) => Object.freeze({
      chunkId: chunk.chunkId, startChar: chunk.startChar, endChar: chunk.endChar,
      vector: embedded.vectors[i]!,
    })));
    await setImmediate();
  }
  params.abortSignal.throwIfAborted();
  if (!modelFingerprint || !dimensions) throw new InformationBasketError("basket_source_no_extractable_text");
  const verified = await params.reader(params.path, params.abortSignal);
  if (verified.contentHash !== document.contentHash || verified.fileIdentity !== document.fileIdentity)
    throw new InformationBasketError("basket_source_changed_during_index", undefined, 409);
  return Object.freeze({
    sizeBytes: document.sizeBytes,
    index: Object.freeze({
      contentHash: document.contentHash, fileIdentity: document.fileIdentity,
      chunkingVersion: 1, totalCharacters: document.text.length,
      profileSignature: basketProfileSignature(params.config, params.profileId),
      modelFingerprint, dimensions, chunks: Object.freeze(vectors),
    }),
  });
}
