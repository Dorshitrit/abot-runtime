import {
  SESSION_MEMORY_CHECKPOINT_KIND,
  type SessionMemoryCheckpoint,
} from "../../../sessions/memory/contracts.js";
import { getSessionMemoryCheckpoint } from "../../../sessions/memory/checkpoint-scope.js";
import {
  assertValidSessionMemoryCheckpoint,
  resolveApplicableSessionMemoryCheckpoint,
} from "../../../sessions/memory/rules.js";
import {
  createSessionMemoryMessageReferences,
  resolveCoveredTurnCount,
  snapshotSessionMemorySource,
  type SessionMemorySourceSnapshot,
} from "../../../sessions/memory/source.js";
import type {
  CreateRequestSessionMemoryParams,
  PreparedSessionMemoryCheckpoint,
  RequestSessionMemory,
  SessionMemoryRequestProjection,
} from "./contracts.js";
import { selectSessionMemoryProjection } from "./selection.js";
import { coordinateExecutionSessionMemory } from "./execution-coordination.js";
import {
  validateRequestSessionMemorySnapshot,
  type RequestSessionMemorySnapshot,
} from "./snapshot-state.js";

export function createRequestSessionMemory(
  params: CreateRequestSessionMemoryParams,
): RequestSessionMemory {
  return coordinateExecutionSessionMemory(new RequestSessionMemoryController(params));
}

class RequestSessionMemoryController implements RequestSessionMemory {
  private readonly source: SessionMemorySourceSnapshot;
  private readonly now: () => Date;
  private checkpoint: SessionMemoryCheckpoint | undefined;
  private readonly persistedCheckpointRevision: number;

  constructor(private readonly params: CreateRequestSessionMemoryParams) {
    const state = resolveInitialSessionMemoryState(params);
    this.source = state.source;
    this.checkpoint = state.checkpoint;
    this.persistedCheckpointRevision = state.persistedCheckpointRevision;
    this.now = params.now ?? (() => new Date());
  }

  snapshot(): RequestSessionMemorySnapshot {
    return Object.freeze({
      kind: "request_session_memory_v1",
      ...(this.source.scope ? { scope: this.source.scope } : {}),
      source: this.source,
      ...(this.checkpoint ? { checkpoint: this.checkpoint } : {}),
      persistedCheckpointRevision: this.persistedCheckpointRevision,
    });
  }

  project(): SessionMemoryRequestProjection {
    return selectSessionMemoryProjection({
      sessionId: this.params.sessionId,
      source: this.source,
      ...(this.checkpoint ? { checkpoint: this.checkpoint } : {}),
    });
  }

  async prepare(
    request: Parameters<RequestSessionMemory["prepare"]>[0],
    onProgress?: Parameters<RequestSessionMemory["prepare"]>[1],
  ): Promise<PreparedSessionMemoryCheckpoint> {
    const currentProjection = this.project();
    if (currentProjection.compactableTurnCount === 0) {
      throw new Error("session_memory_compaction_not_available");
    }
    const coveredTurnCount = resolveCoveredTurnCount(
      this.source,
      this.checkpoint,
    );
    if (coveredTurnCount === undefined) {
      throw new Error("session_memory_checkpoint_coverage_invalid");
    }
    const nextCoveredTurnCount =
      coveredTurnCount + currentProjection.compactableTurnCount;
    const compactableTurns = this.source.turns.slice(
      coveredTurnCount,
      nextCoveredTurnCount,
    );
    const summary = await this.params.compactor.compact({
      ...(this.source.scope ? { scope: this.source.scope } : {}),
      request,
      ...(this.checkpoint ? { previousSummary: this.checkpoint.summary } : {}),
      turns: compactableTurns,
      onProgress,
    });
    const expectedCheckpointRevision = this.checkpoint
      ? this.checkpoint.revision
      : this.persistedCheckpointRevision;
    const checkpoint = Object.freeze({
      kind: SESSION_MEMORY_CHECKPOINT_KIND,
      revision: expectedCheckpointRevision + 1,
      sourceRevision: this.source.sourceRevision,
      coveredMessages: createSessionMemoryMessageReferences(
        this.source.turns.slice(0, nextCoveredTurnCount),
        this.source.scope,
      ),
      summary,
      createdAt: this.now().toISOString(),
    });
    assertValidSessionMemoryCheckpoint(checkpoint);
    let committed = false;
    return Object.freeze({
      checkpoint,
      coveredTurnCount: nextCoveredTurnCount,
      projection: selectSessionMemoryProjection({
        sessionId: this.params.sessionId,
        source: this.source,
        checkpoint,
      }),
      commit: async () => {
        if (committed) {
          throw new Error("session_memory_checkpoint_already_committed");
        }
        const result =
          await this.params.repository.compareAndSwapSessionMemoryCheckpoint(
            this.params.sessionId,
            {
              ...(this.source.scope ? { scope: this.source.scope } : {}),
              expectedSourceRevision: this.source.sourceRevision,
              expectedCheckpointRevision,
              checkpoint,
            },
          );
        if (!result.committed) {
          throw new Error(`session_memory_${result.reason}`);
        }
        this.checkpoint = result.checkpoint;
        committed = true;
      },
    });
  }
}

function resolveInitialSessionMemoryState(
  params: CreateRequestSessionMemoryParams,
): RequestSessionMemorySnapshot {
  if ("snapshot" in params)
    return validateRequestSessionMemorySnapshot(params.snapshot);
  const checkpoint = resolveApplicableSessionMemoryCheckpoint(params.session, params.scope);
  return Object.freeze({
    kind: "request_session_memory_v1",
    ...(params.scope ? { scope: params.scope } : {}),
    source: snapshotSessionMemorySource(params.session, params.scope),
    ...(checkpoint ? { checkpoint } : {}),
    persistedCheckpointRevision: normalizeCheckpointRevision(
      getSessionMemoryCheckpoint(params.session, params.scope)?.revision,
    ),
  });
}

function normalizeCheckpointRevision(revision: number | undefined): number {
  if (
    revision === undefined ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    return 0;
  }
  return revision;
}
