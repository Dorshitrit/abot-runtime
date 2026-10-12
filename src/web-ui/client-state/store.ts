import { open, readFile, rm, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock } from "../../runtime/adapters/long-term-memory/file-lock.js";
import { ensurePrivateRuntimeDirectory } from "../../runtime/local-host/private-directory.js";
import { replacePreparedSessionFile } from "../../sessions/prepared-session-replacement.js";
import { isPersistedStore } from "../app/lib/session-composer-queue.js";
import { ClientStateError, emptyClientState, type ClientState } from "./contracts.js";
import { decodePreference } from "./preferences.js";

const maxStateBytes = 8 * 1024 * 1024;

function decodeState(raw: string): ClientState {
  const state = JSON.parse(raw) as ClientState;
  if (state?.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      typeof state.introductionSeen !== "boolean" || !state.preferences ||
      typeof state.preferences !== "object" || Array.isArray(state.preferences) || typeof state.queue !== "string")
    throw new Error("Workspace state is invalid. Its existing file has been preserved.");
  for (const [key, value] of Object.entries(state.preferences)) decodePreference(key, value);
  if (state.queue && !isPersistedStore(JSON.parse(state.queue)))
    throw new Error("Saved message queue is invalid. Its existing file has been preserved.");
  return state;
}

/** One installation; independent of listener ports, browser profiles and operating system. */
export class WebClientStateStore {
  private initialization?: Promise<void>;
  readonly directory: string;
  readonly path: string;
  constructor(rootDir: string) {
    this.directory = resolve(rootDir, ".runtime", "web-ui", "client-state");
    this.path = join(this.directory, "state.json");
  }
  private async load(): Promise<ClientState> {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > maxStateBytes)
        throw new Error("Workspace state must be a bounded regular file.");
      return decodeState(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return emptyClientState();
      throw error;
    }
  }
  private async save(state: ClientState): Promise<void> {
    const raw = JSON.stringify(state);
    if (Buffer.byteLength(raw) > maxStateBytes)
      throw new ClientStateError("workspace_storage_full", "Workspace settings and queued messages exceed their storage limit. No saved data was discarded.", 413);
    decodeState(raw);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(raw); await file.sync(); }
      finally { await file.close(); }
      await replacePreparedSessionFile(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }
  async transaction<T>(operation: (state: ClientState) => T): Promise<{ result: T; state: ClientState }> {
    const initializing = this.initialization ??= ensurePrivateRuntimeDirectory(this.directory);
    try { await initializing; }
    catch (error) {
      // A later explicit reload may try again after the directory is repaired.
      if (this.initialization === initializing) this.initialization = undefined;
      throw error;
    }
    return withFileLock(join(this.directory, "state.lock"), async () => {
      const state = await this.load();
      const before = JSON.stringify(state);
      const result = operation(state);
      if (JSON.stringify(state) !== before) {
        state.revision += 1;
        await this.save(state);
      }
      return { result, state };
    });
  }
}
