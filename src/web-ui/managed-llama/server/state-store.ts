import { lstat, link, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalManagedDirectory, createManagedFile, openManagedRead, syncManagedDirectory, verifyPrivateManagedFile } from "../host-files.js";
import { parseServerSettings, serverFailure, type ServerSettings } from "./settings.js";

export interface SavedServerState { schema: 1; revision: string; apiKey: string; settings: ServerSettings }
function check(value: unknown): asserts value { if (!value) throw serverFailure("server_state_unavailable"); }
function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function parse(text: string): SavedServerState {
  const raw = JSON.parse(text);
  check(raw && raw.schema === 1 && /^[a-f0-9]{32}$/u.test(raw.revision) && /^[a-f0-9]{64}$/u.test(raw.apiKey));
  const result: SavedServerState = { schema: 1, revision: raw.revision, apiKey: raw.apiKey, settings: parseServerSettings(raw.settings) };
  check(JSON.stringify(result) + "\n" === text);
  return result;
}

/** Separate from legacy launch preferences: no implicit migration or autostart. */
export class ServerStateStore {
  constructor(private readonly directory: string) {}
  async read(): Promise<SavedServerState | null> {
    await canonicalManagedDirectory(this.directory, true);
    const path = join(this.directory, "server-state.json");
    let before;
    try { before = await lstat(path); } catch (error) { if (missing(error)) return null; throw error; }
    check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
    const file = await openManagedRead(path);
    try {
      const stat = await file.stat();
      await verifyPrivateManagedFile(path, stat, 0o600);
      check(stat.nlink === 1 && stat.ino === before.ino && stat.dev === before.dev && stat.size > 0 && stat.size <= 1_048_576);
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const after = await file.stat();
      check(length === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs);
      return parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    } finally { await file.close(); }
  }
  async save(settings: ServerSettings, expectedRevision: string | null): Promise<SavedServerState> {
    const normalized = parseServerSettings(settings);
    await canonicalManagedDirectory(this.directory, true);
    const lockPath = join(this.directory, "server-state.lock");
    let lock;
    try { lock = await createManagedFile(lockPath); }
    catch { throw serverFailure("server_state_busy"); }
    try {
      const previous = await this.read();
      if ((previous?.revision ?? null) !== expectedRevision) throw serverFailure("server_settings_changed");
      const next: SavedServerState = { schema: 1, revision: randomBytes(16).toString("hex"),
        apiKey: previous?.apiKey ?? randomBytes(32).toString("hex"), settings: normalized };
      await this.publish(next, previous);
      return next;
    } finally {
      await lock.close();
      await canonicalManagedDirectory(this.directory, true);
      await unlink(lockPath);
      await syncManagedDirectory(this.directory);
    }
  }
  private async publish(next: SavedServerState, previous: SavedServerState | null): Promise<void> {
    const destination = join(this.directory, "server-state.json");
    const temporary = join(this.directory, ".server-state-" + randomBytes(16).toString("hex") + ".tmp");
    const file = await createManagedFile(temporary);
    let exists = true;
    try {
      try {
        await verifyPrivateManagedFile(temporary, await file.stat(), 0o600);
        await file.writeFile(JSON.stringify(next) + "\n", "utf8");
        await file.sync();
      } finally { await file.close(); }
      await canonicalManagedDirectory(this.directory, true);
      check(JSON.stringify(await this.read()) === JSON.stringify(previous));
      if (previous) {
        await rename(temporary, destination);
      } else {
        await link(temporary, destination);
        await unlink(temporary);
      }
      exists = false;
      await syncManagedDirectory(this.directory);
    } finally { if (exists) await unlink(temporary); }
  }
}
