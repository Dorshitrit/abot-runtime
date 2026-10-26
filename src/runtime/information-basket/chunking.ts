import { InformationBasketError, type BasketChunkReference } from "./contracts.js";
import { BASKET_LIMITS } from "./limits.js";

export type BasketTextChunk = BasketChunkReference & Readonly<{ text: string }>;

function chooseBasketChunkEnd(text: string, start: number): number {
  const ceiling = Math.min(text.length, start + BASKET_LIMITS.chunkCharacters);
  if (ceiling === text.length) return ceiling;
  const paragraph = text.lastIndexOf("\n", ceiling);
  const minimum = start + Math.floor(BASKET_LIMITS.chunkCharacters / 2);
  if (paragraph >= minimum) return paragraph + 1;
  const space = text.lastIndexOf(" ", ceiling);
  return space >= minimum ? space + 1 : ceiling;
}

export function chunkBasketText(text: string): readonly BasketTextChunk[] {
  const chunks: BasketTextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const end = chooseBasketChunkEnd(text, start);
    if (chunks.length >= BASKET_LIMITS.maxChunks)
      throw new InformationBasketError("basket_source_chunk_limit");
    chunks.push(Object.freeze({
      chunkId: "chunk-" + chunks.length, startChar: start, endChar: end,
      text: text.slice(start, end),
    }));
    if (end === text.length) break;
    start = Math.max(start + 1, end - BASKET_LIMITS.chunkOverlap);
  }
  return Object.freeze(chunks);
}
