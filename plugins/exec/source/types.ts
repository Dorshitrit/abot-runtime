import type { ExecOutputBody } from "./output-contracts.js";

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
  | "output_storage_failed"
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
  /** Plugin-private disk receipt; never projected as model instructions. */
  body?: ExecOutputBody;
}>;

export type ExecProcessSnapshot = Readonly<{
  processId: string;
  status: "running" | "settled";
  nextCursor?: number;
  /** Plugin-private terminal presentation reservation; never persisted. */
  deliveryId?: string;
  exitCode?: number;
  stdout: ExecStreamSnapshot;
  stderr: ExecStreamSnapshot;
  terminationReason?: ExecTerminationReason;
  elapsedMs: number;
  outputFailure?: Readonly<{
    code: string;
    stdoutBytes: number;
    stderrBytes: number;
  }>;
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

export type ExecWorkingDirectory = Readonly<{
  absolutePath: string;
  logicalPath: string;
}>;

export type PendingExecExecution = Readonly<{
  commandPreview: string;
  cwd: ExecWorkingDirectory;
  filesystemStateBefore: ExecFilesystemSnapshot | null;
  hardTimeoutMs: number;
  idleTimeoutMs: number;
}>;
