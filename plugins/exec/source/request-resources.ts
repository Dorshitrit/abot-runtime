import type {
  ToolRequestPreparationContext,
  ToolExecutionContext,
} from "../../../src/plugin-sdk/index.js";
import type { ExecProcessManager } from "./process-manager.js";
import type {
  ExecProcessSnapshot,
  PendingExecExecution,
  ExecFilesystemSnapshot,
} from "./types.js";
import { ExecPluginError } from "./errors.js";

type SavedExecution = Readonly<{
  processId: string;
  scope: string;
  cursor: number;
  snapshot: ExecProcessSnapshot;
  execution: Omit<PendingExecExecution, "filesystemStateBefore"> & {
    filesystemStateBefore:
      | (Omit<ExecFilesystemSnapshot, "entries"> & {
          entries: readonly (readonly [string, unknown])[];
        })
      | null;
  };
}>;

/** Serializes only terminal output; a live child is never restored or replayed. */
export class ExecRequestResources {
  private readonly owned = new Map<string, string>();
  private readonly restored = new Map<string, SavedExecution>();
  constructor(
    private readonly manager: ExecProcessManager,
    private readonly pending: Map<string, PendingExecExecution>,
    preparation?: ToolRequestPreparationContext,
  ) {
    const state = preparation?.requestState;
    if (!state) return;
    const saved = state.read("exec.terminal.v1");
    if (saved !== undefined) this.restore(saved);
    state.register("exec.terminal.v1", {
      snapshot: () => this.snapshot(),
      dispose: () => this.dispose(),
    });
  }
  started(
    processId: string,
    scope: string,
    settled: Promise<void>,
    context?: ToolExecutionContext,
  ) {
    this.owned.set(processId, scope);
    context?.requestWork?.trackUntil(settled);
  }
  forget(processId: string) {
    this.owned.delete(processId);
    this.restored.delete(processId);
  }
  terminal(
    processId: string,
    scope: string,
    cursor?: number,
  ): ExecProcessSnapshot | undefined {
    const entry = this.restored.get(processId);
    if (!entry) return undefined;
    if (entry.scope !== scope)
      throw new ExecPluginError(
        "unknown_exec_process",
        "The exec process belongs to a different session.",
      );
    if (cursor !== undefined && cursor !== entry.cursor)
      throw new ExecPluginError(
        "stale_exec_process_cursor",
        "The saved exec cursor is stale.",
      );
    this.restored.delete(processId);
    return structuredClone(entry.snapshot);
  }
  private snapshot() {
    const executions: SavedExecution[] = [...this.restored.values()];
    for (const [processId, scope] of this.owned) {
      const execution = this.pending.get(processId);
      if (!execution) continue;
      const terminal = this.manager.snapshotSettled(processId, scope);
      const before = execution.filesystemStateBefore;
      executions.push({
        processId,
        scope,
        ...terminal,
        execution: {
          ...execution,
          filesystemStateBefore: before
            ? { ...before, entries: [...before.entries] }
            : null,
        },
      });
    }
    return { kind: "exec_terminal_state_v1", executions };
  }
  private restore(value: unknown) {
    if (
      !isRecord(value) ||
      value.kind !== "exec_terminal_state_v1" ||
      !Array.isArray(value.executions)
    )
      throw invalid();
    for (const entry of value.executions) {
      if (!isSavedExecution(entry) || this.restored.has(entry.processId))
        throw invalid();
      const before = entry.execution.filesystemStateBefore;
      this.restored.set(entry.processId, structuredClone(entry));
      this.pending.set(entry.processId, {
        ...structuredClone(entry.execution),
        filesystemStateBefore: before
          ? { ...before, entries: new Map(before.entries as [string, any][]) }
          : null,
      });
    }
  }
  private async dispose() {
    for (const [processId, scope] of this.owned) {
      try {
        await this.manager.cancel({ processId, scope });
      } catch {}
      try {
        await this.manager.release(processId, scope);
      } catch {}
      this.pending.delete(processId);
    }
    for (const id of this.restored.keys()) this.pending.delete(id);
    this.owned.clear();
    this.restored.clear();
  }
}
function isSavedExecution(value: unknown): value is SavedExecution {
  if (
    !isRecord(value) ||
    typeof value.processId !== "string" ||
    typeof value.scope !== "string" ||
    !Number.isSafeInteger(value.cursor) ||
    value.cursor < 1 ||
    !isRecord(value.snapshot) ||
    value.snapshot.processId !== value.processId ||
    value.snapshot.status !== "settled" ||
    !isStream(value.snapshot.stdout) ||
    !isStream(value.snapshot.stderr) ||
    !Number.isFinite(value.snapshot.elapsedMs) ||
    !isRecord(value.execution) ||
    typeof value.execution.commandPreview !== "string" ||
    !isRecord(value.execution.cwd) ||
    typeof value.execution.cwd.absolutePath !== "string" ||
    typeof value.execution.cwd.logicalPath !== "string"
  )
    return false;
  if (
    ![
      value.execution.hardTimeoutMs,
      value.execution.idleTimeoutMs,
      value.execution.outputMaxChars,
    ].every(Number.isFinite)
  )
    return false;
  const before = value.execution.filesystemStateBefore;
  return (
    before === null ||
    (isRecord(before) &&
      typeof before.absoluteRoot === "string" &&
      typeof before.logicalRoot === "string" &&
      typeof before.rootExists === "boolean" &&
      typeof before.complete === "boolean" &&
      Array.isArray(before.entries) &&
      before.entries.every(
        (entry: unknown) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "string" &&
          isRecord(entry[1]) &&
          typeof entry[1].kind === "string" &&
          [entry[1].mode, entry[1].size, entry[1].mtimeMs].every(
            Number.isFinite,
          ),
      ))
  );
}
function isStream(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    typeof value.sawOutput === "boolean" &&
    isRecord(value.metadata) &&
    typeof value.metadata.truncated === "boolean" &&
    [
      value.metadata.originalChars,
      value.metadata.returnedChars,
      value.metadata.omittedChars,
    ].every(Number.isFinite)
  );
}
function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function invalid() {
  return new Error("exec_terminal_snapshot_invalid");
}
