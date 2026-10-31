import type { CompactionProgressObserver } from "../../model/context-compaction-progress.js";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type {
  SessionMemoryCheckpoint,
  SessionMemoryRepository,
  SessionMemoryScope,
} from "../../../sessions/memory/contracts.js";
import type { SessionRecord } from "../../../sessions/types.js";
import type { SessionMemorySettledTurn } from "../../../sessions/memory/source.js";
import type { RequestHistoryMessage } from "../request-context-contracts.js";
import type { BoundRequestModelInvocationContext } from "../../request/contracts.js";
import type { RequestSessionMemorySnapshot } from "./snapshot-state.js";

export const SESSION_MEMORY_PROTECTED_TURN_COUNT = 10;

export type SessionMemoryRequestProjection = Readonly<{
  priorConversationMessages: readonly ChatMessage[];
  historyMessages: readonly RequestHistoryMessage[];
  compactableTurnCount: number;
  checkpointRevision: number;
  sourceRevision: string;
}>;

export type PreparedSessionMemoryCheckpoint = Readonly<{
  checkpoint: SessionMemoryCheckpoint;
  coveredTurnCount: number;
  projection: SessionMemoryRequestProjection;
  commit(): Promise<void>;
}>;

export type RequestSessionMemory = Readonly<{
  snapshot?(): RequestSessionMemorySnapshot;
  project(): SessionMemoryRequestProjection;
  prepare(
    request: BoundRequestModelInvocationContext,
    onProgress?: CompactionProgressObserver,
  ): Promise<PreparedSessionMemoryCheckpoint>;
}>;

export type SessionMemoryCompactor = Readonly<{
  compact(params: {
    scope?: SessionMemoryScope;
    request: BoundRequestModelInvocationContext;
    previousSummary?: string;
    turns: readonly SessionMemorySettledTurn[];
    onProgress?: CompactionProgressObserver;
  }): Promise<string>;
}>;

export type CreateRequestSessionMemoryParams = Readonly<{
  scope?: SessionMemoryScope;
  sessionId: string;
  repository: SessionMemoryRepository;
  compactor: SessionMemoryCompactor;
  now?: () => Date;
}> &
  (
    | Readonly<{ session: SessionRecord }>
    | Readonly<{ snapshot: RequestSessionMemorySnapshot }>
  );
