export const SESSION_MEMORY_CHECKPOINT_KIND =
  "runtime_session_memory_checkpoint_v1" as const;

export const SESSION_MEMORY_SUMMARY_MAX_CHARACTERS = 12_000;

export type SessionMemoryMessageReference = Readonly<{
  messageId: string;
  fingerprint: string;
}>;

export type SessionMemoryCheckpoint = Readonly<{
  kind: typeof SESSION_MEMORY_CHECKPOINT_KIND;
  revision: number;
  sourceRevision: string;
  coveredMessages: readonly SessionMemoryMessageReference[];
  summary: string;
  createdAt: string;
}>;

export type SessionMemoryCheckpointCommit = Readonly<{
  expectedSourceRevision: string;
  expectedCheckpointRevision: number;
  checkpoint: SessionMemoryCheckpoint;
}>;

export type SessionMemoryCheckpointCommitResult =
  | Readonly<{
      committed: true;
      checkpoint: SessionMemoryCheckpoint;
    }>
  | Readonly<{
      committed: false;
      reason: "source_revision_mismatch" | "checkpoint_revision_mismatch";
    }>;

export type SessionMemoryRepository = Readonly<{
  compareAndSwapSessionMemoryCheckpoint(
    sessionId: string,
    command: SessionMemoryCheckpointCommit,
  ): Promise<SessionMemoryCheckpointCommitResult>;
}>;
