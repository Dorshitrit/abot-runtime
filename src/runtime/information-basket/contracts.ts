import type { ModelGatewayEmbeddingResult } from "../../model-gateway/types.js";
import type { ModelGatewayClient, RuntimeConfig } from "../ports.js";

export type BasketSourceStatus =
  | "queued" | "indexing" | "ready" | "stale" | "missing" | "failed" | "unsupported";

export type BasketSource = Readonly<{
  sourceId: string;
  displayName: string;
  path: string;
  revision: number;
  status: BasketSourceStatus;
  sizeBytes: number | null;
  chunkCount: number;
  indexedAt: string | null;
  reason: string | null;
}>;

export type BasketSettings = Readonly<{
  revision: number;
  enabled: boolean;
  embeddingProfileId: string | null;
}>;

export type BasketEmbeddingProfile = Readonly<{
  id: string;
  label: string;
  provider: string;
  model: string;
}>;

export type BasketView = Readonly<{
  settings: BasketSettings;
  sources: readonly BasketSource[];
  embeddingProfiles: readonly BasketEmbeddingProfile[];
  supportedExtensions: readonly string[];
  limits: Readonly<{
    maxSources: number;
    maxSourceBytes: number;
    maxReadCharacters: number;
  }>;
}>;

export type BasketSettingsChange = Readonly<{
  expectedRevision: number;
  enabled: boolean;
  embeddingProfileId: string | null;
}>;

export type BasketSourceRevision = Readonly<{
  sourceId: string;
  expectedRevision: number;
}>;

export type BasketSourceRelink = BasketSourceRevision & Readonly<{ path: string }>;

export type BasketFilePage = Readonly<{
  directory: string;
  parent: string | null;
  entries: readonly Readonly<{
    name: string;
    path: string;
    kind: "directory" | "file";
    supported: boolean;
  }>[];
  nextCursor: string | null;
  roots: readonly Readonly<{ label: string; path: string }>[];
  hostPlatform: NodeJS.Platform;
}>;

export type BasketChunkReference = Readonly<{
  chunkId: string;
  startChar: number;
  endChar: number;
}>;

export type BasketSearchCandidate = BasketSourceRevision & Readonly<{
  displayName: string;
  path: string;
  score: number;
  matches: readonly BasketChunkReference[];
  excerpt?: string;
}>;

export type BasketSearchResult = Readonly<{
  status: "found" | "empty" | "unavailable";
  sources: readonly BasketSearchCandidate[];
  omittedCount: number;
  reason?: string;
}>;

export type BasketSearchInput = Readonly<{
  query: string;
  abortSignal: AbortSignal;
  maxSources?: number;
  includeExcerpts?: boolean;
}>;

export type BasketReadInput = BasketSourceRevision & Readonly<{
  startChar?: number;
  maxChars?: number;
  abortSignal?: AbortSignal;
}>;

export type BasketReadResult = BasketSourceRevision & Readonly<{
  displayName: string;
  path: string;
  contentHash: string;
  text: string;
  startChar: number;
  endChar: number;
  totalCharacters: number;
  omittedBefore: number;
  omittedAfter: number;
  nextStartChar: number | null;
}>;

export type BasketDiscoveryChange = Readonly<{
  settingsChanged: boolean;
  invalidatedSourceIds: readonly string[];
  readySourcesAdded: boolean;
}>;

export type InformationBasketService = Readonly<{
  isReady(): boolean;
  list(input?: Readonly<{ verifySources: boolean; abortSignal?: AbortSignal }>): Promise<BasketView>;
  updateSettings(input: BasketSettingsChange): Promise<BasketView>;
  browseFiles(input?: Readonly<{ path?: string; cursor?: string }>): Promise<BasketFilePage>;
  addSources(input: Readonly<{ paths: readonly string[] }>): Promise<BasketView>;
  removeSource(input: BasketSourceRevision): Promise<BasketView>;
  refreshSource(input: BasketSourceRevision): Promise<BasketView>;
  relinkSource(input: BasketSourceRelink): Promise<BasketView>;
  search(input: BasketSearchInput): Promise<BasketSearchResult>;
  readSource(input: BasketReadInput): Promise<BasketReadResult>;
  subscribeChanges(listener: (change: BasketDiscoveryChange) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}>;

export type BasketEmbeddingResult = Pick<
  ModelGatewayEmbeddingResult, "modelFingerprint" | "dimensions" | "vectors"
>;

export type InformationBasketOptions = Readonly<{
  config: RuntimeConfig;
  models: Pick<ModelGatewayClient, "embed">;
  onChanged?: () => void;
}>;

export class InformationBasketError extends Error {
  constructor(
    readonly code: string,
    message: string = code,
    readonly status = 400,
  ) {
    super(message);
    this.name = "InformationBasketError";
  }
}
