import type { ResolvedRuntimeToolPath } from "../../../src/plugin-sdk/index.js";

export type ExecActionSummary = Readonly<{
  type: string;
  target?: string;
  details?: string;
}>;

export type ExecTerminationReason =
  | "aborted"
  | "cancelled"
  | "completed"
  | "hard_timeout"
  | "idle_timeout"
  | "spawn_failed";

export type ExecStreamMetadata = Readonly<{
  truncated: boolean;
  originalChars: number;
  returnedChars: number;
  omittedChars: number;
}>;

export type ExecStreamSnapshot = Readonly<{
  text: string;
  metadata: ExecStreamMetadata;
  sawOutput: boolean;
}>;

export type ExecProcessSnapshot = Readonly<{
  processId: string;
  status: "running" | "settled";
  nextCursor?: number;
  exitCode?: number;
  stdout: ExecStreamSnapshot;
  stderr: ExecStreamSnapshot;
  terminationReason?: ExecTerminationReason;
  elapsedMs: number;
}>;

export type ExecFilesystemEntry = Readonly<{
  kind: "directory" | "file" | "other" | "symlink";
  mode: number;
  size: number;
  mtimeMs: number;
  contentHash?: string;
  linkTarget?: string;
}>;

export type ExecFilesystemSnapshot = Readonly<{
  absoluteRoot: string;
  logicalRoot: string;
  rootExists: boolean;
  complete: boolean;
  entries: ReadonlyMap<string, ExecFilesystemEntry>;
}>;

export type ExecFilesystemDelta = Readonly<{
  observedStateChange: boolean;
  changedEntryCount: number;
  actions: readonly ExecActionSummary[];
  observation: Readonly<{
    complete: boolean;
    actionLimit: number;
    actionsTruncated: boolean;
  }>;
}>;

export type PendingExecExecution = Readonly<{
  commandPreview: string;
  commandWasNormalized: boolean;
  cwd: ResolvedRuntimeToolPath;
  filesystemStateBefore: ExecFilesystemSnapshot | null;
  hardTimeoutMs: number;
  idleTimeoutMs: number;
  outputMaxChars: number;
}>;
