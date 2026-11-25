import { isReplayedAgentDeletion } from "./deletion-state.js";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withFileLock } from "../adapters/long-term-memory/file-lock.js";
import { fileSystemErrorCode } from "../adapters/long-term-memory/file-lock/contracts.js";
import { ensurePrivateRuntimeDirectory } from "../local-host/private-directory.js";
import { createEmptyAgentState, type AgentState } from "./agent-records.js";
import type { AgentStateCommand } from "./state-commands.js";
import { AgentStateError } from "./state-error.js";
import { reduceAgentCommand } from "./state-reducer.js";
import { readAgentState } from "./state-validation.js";
import {
  AgentStateCommitUnknownError,
  syncAgentStateDirectoryPath,
  writeDurableAgentState,
} from "./durable-state-file.js";

export { AgentStateCommitUnknownError } from "./durable-state-file.js";

/** Every operation reloads under the shared process lock. No snapshot is cached. */
export class FileAgentStateStore {
  private readonly filename: string;
  private readonly directory: string;
  private tail: Promise<void> = Promise.resolve();
  private reconciliationRequired: AgentStateCommitUnknownError | undefined;

  constructor(
    filename: string,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    this.filename = resolve(filename);
    this.directory = dirname(this.filename);
  }

  read(): Promise<AgentState> {
    return this.serialize(() =>
      this.withStoreLock(async () => {
        this.assertReconciled();
        return this.loadDurableState();
      }),
    );
  }

  commit(
    command: AgentStateCommand,
    expectedRevision: number,
  ): Promise<AgentState> {
    return this.commitSerialized(command, expectedRevision).then((receipt) => receipt.state);
  }

  /** Internal application receipts still validate exact source revisions under the same lock. */
  commitApplication(command: AgentStateCommand): Promise<AgentState> {
    return this.commitSerialized(command).then((receipt) => receipt.state);
  }

  async beginDeletion(agentId: string, expectedRevision: number): Promise<AgentState> {
    assertExpectedRevision(expectedRevision);
    return this.commit({kind: "begin_agent_deletion", agentId}, expectedRevision);
  }

  finishDeletion(agentId: string): Promise<AgentState> {
    return this.commitApplication({kind: "finish_agent_deletion", agentId});
  }

  /** External work may start only for the caller whose admission actually changed durable state. */
  admitMessage(command: Extract<AgentStateCommand, {kind:"open_agent_turn"}>): Promise<{state: AgentState; changed: boolean}> {
    return this.commitSerialized(command);
  }

  private commitSerialized(command: AgentStateCommand, expectedRevision?: number): Promise<{state: AgentState; changed: boolean}> {
    // Capture caller-owned objects before waiting behind another mutation.
    const captured = structuredClone(command);
    return this.serialize(() =>
      this.withStoreLock(async () => {
        this.assertReconciled();
        if (expectedRevision !== undefined) assertExpectedRevision(expectedRevision);
        const state = await this.loadDurableState();
        if (expectedRevision !== undefined && state.revision !== expectedRevision && !isReplayedAgentDeletion(state, captured))
          throw new AgentStateError("agents_state_revision_conflict");
        const next = readAgentState(
          reduceAgentCommand(state, captured, this.clock()),
        );
        if (next.revision === state.revision) return {state:structuredClone(next), changed:false};
        try {
          await writeDurableAgentState(this.filename, next);
        } catch (error) {
          if (error instanceof AgentStateCommitUnknownError)
            this.reconciliationRequired = error;
          throw error;
        }
        return {state:structuredClone(next), changed:true};
      }),
    );
  }

  reconcile(): Promise<AgentState> {
    return this.serialize(() =>
      this.withStoreLock(async () => {
        const state = await this.loadDurableState();
        this.reconciliationRequired = undefined;
        return state;
      }),
    );
  }

  private assertReconciled(): void {
    if (!this.reconciliationRequired) return;
    throw new AgentStateError("agents_state_reconciliation_required", {
      cause: this.reconciliationRequired,
    });
  }

  private async loadDurableState(): Promise<AgentState> {
    const state = await readStoredAgentState(this.filename);
    await syncAgentStateDirectoryPath(this.directory);
    return structuredClone(state);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
    await ensurePrivateRuntimeDirectory(this.directory);
    let primaryFailure: { error: unknown } | undefined;
    try {
      return await withFileLock(`${this.filename}.lock`, async () => {
        try {
          return await operation();
        } catch (error) {
          primaryFailure = { error };
          throw error;
        }
      });
    } catch (error) {
      // A failed lock cleanup must not hide revision, validation or commit errors.
      if (primaryFailure) throw primaryFailure.error;
      throw error;
    }
  }
}

function assertExpectedRevision(revision: number): void {
  if (Number.isSafeInteger(revision) && revision >= 0) return;
  throw new AgentStateError("agents_state_revision_invalid");
}

async function readStoredAgentState(filename: string): Promise<AgentState> {
  try {
    const entry = await lstat(filename);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new AgentStateError("agents_state_file_invalid");
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return createEmptyAgentState();
    throw error;
  }
  const handle = await open(filename, "r");
  try {
    const content = await handle.readFile("utf8");
    return readAgentState(JSON.parse(content));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new AgentStateError("agents_state_invalid", { cause: error });
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
