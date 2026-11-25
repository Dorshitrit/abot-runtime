import { randomUUID } from "node:crypto";
import { lstat, open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withFileLock } from "../adapters/long-term-memory/file-lock.js";
import { ensurePrivateRuntimeDirectory } from "../local-host/private-directory.js";
import { replacePreparedSessionFile } from "../../sessions/prepared-session-replacement.js";
import { syncAgentStateDirectoryPath } from "./durable-state-file.js";
import type { AgentScheduleState } from "./schedule-contracts.js";
import { readAgentScheduleState } from "./schedule-validation.js";
import { AgentStateError } from "./state-error.js";

/** Independent Agent schedule journal. Never writes the ordinary scheduler or sessions. */
export class AgentScheduleStore {
  private readonly filename: string;
  constructor(filename: string) { this.filename = resolve(filename); }
  async transaction<T>(operation: (state: AgentScheduleState) => T | Promise<T>): Promise<T> {
    const directory = dirname(this.filename);
    await ensurePrivateRuntimeDirectory(directory);
    return withFileLock(`${this.filename}.lock`, async () => {
      const state = await this.load();
      await syncAgentStateDirectoryPath(directory);
      const before = JSON.stringify(state);
      const result = await operation(state);
      if (JSON.stringify(state) !== before) {
        state.revision += 1;
        await this.write(readAgentScheduleState(state));
      }
      return structuredClone(result);
    });
  }
  private async load(): Promise<AgentScheduleState> {
    try {
      const stat = await lstat(this.filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new AgentStateError("agents_schedule_file_invalid");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 2, revision: 0, schedules: [] };
      throw error;
    }
    const file = await open(this.filename, "r");
    try { return readAgentScheduleState(JSON.parse(await file.readFile("utf8"))); }
    finally { await file.close(); }
  }
  private async write(state: AgentScheduleState): Promise<void> {
    const temporary = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
    let replaced = false;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(state), "utf8"); await file.sync(); }
      finally { await file.close(); }
      await replacePreparedSessionFile(temporary, this.filename); replaced = true;
      await syncAgentStateDirectoryPath(dirname(this.filename));
    } catch (error) {
      if (!replaced) await rm(temporary, { force: true }).catch(() => undefined);
      throw new AgentStateError(replaced ? "agents_schedule_commit_unknown" : "agents_schedule_write_failed", { cause: error });
    }
  }
}
