import type { BasketSettings, BasketSource, BasketChunkReference } from "./contracts.js";

export type BasketIndexedChunk = BasketChunkReference & Readonly<{
  vector: readonly number[];
}>;
export type BasketSourceIndex = Readonly<{
  contentHash: string;
  fileIdentity: string;
  chunkingVersion: 1;
  totalCharacters: number;
  profileSignature: string;
  modelFingerprint: string;
  dimensions: number;
  chunks: readonly BasketIndexedChunk[];
}>;
export type StoredBasketSource = BasketSource & Readonly<{
  index: BasketSourceIndex | null;
}>;
export type BasketSnapshot = Readonly<{
  schemaVersion: 1;
  hostNamespace: string;
  settings: BasketSettings;
  sources: readonly StoredBasketSource[];
}>;
export type BasketRepository = Readonly<{
  read(): Promise<BasketSnapshot>;
  update(change: (state: BasketSnapshot) => BasketSnapshot): Promise<BasketSnapshot>;
}>;
export type BasketSourceDocument = Readonly<{
  text: string;
  contentHash: string;
  fileIdentity: string;
  sizeBytes: number;
}>;
export type BasketSourceReader = (
  path: string,
  signal?: AbortSignal,
) => Promise<BasketSourceDocument>;

export function emptyBasketSnapshot(hostNamespace: string): BasketSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    hostNamespace,
    settings: Object.freeze({ revision: 1, enabled: true, embeddingProfileId: null }),
    sources: Object.freeze([]),
  });
}

export function projectBasketSource(source: StoredBasketSource): BasketSource {
  const { index: _index, ...metadata } = source;
  return Object.freeze(metadata);
}
