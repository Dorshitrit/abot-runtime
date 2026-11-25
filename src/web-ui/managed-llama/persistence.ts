import { lstat, open, link, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ManagedLlamaError, type LaunchSettings } from "./contracts.js";
import { canonicalManagedDirectory, createManagedFile, isLocalModelPath, openManagedRead, privatePosixMode, syncManagedDirectory as syncDirectory, verifyPrivateManagedFile } from "./host-files.js";

type State = { schema: 1; apiKey: string; preferences: LaunchSettings };
const queues = new Map<string, Promise<unknown>>();
const MAX_BYTES = 32768;
function failure(): ManagedLlamaError {
  return new ManagedLlamaError("persistence_unavailable", "Managed llama.cpp persistence unavailable.");
}
function check(value: unknown): asserts value { if (!value) throw failure(); }
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value));
  check(Object.getPrototypeOf(value) === Object.prototype);
  const own = Reflect.ownKeys(value);
  check(own.length === keys.length && own.every(k => typeof k === "string" && keys.includes(k)));
  check(keys.every(k => Object.getOwnPropertyDescriptor(value, k)?.get === undefined));
}
function preferences(value: unknown): LaunchSettings {
  exact(value, ["modelPath", "alias", "port", "contextTokens", "gpuLayers"]);
  const { modelPath, alias, port, contextTokens, gpuLayers } = value;
  check(typeof modelPath === "string" && modelPath.length > 0 && modelPath.length <= 4096 && isLocalModelPath(modelPath) && /\.gguf$/i.test(modelPath) && !/[\u0000-\u001f\u007f]/u.test(modelPath));
  check(typeof alias === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(alias));
  function integer(n: unknown, low: number, high: number): asserts n is number {
    check(typeof n === "number" && Number.isSafeInteger(n) && n >= low && n <= high);
  }
  integer(port, 1024, 65535); integer(contextTokens, 512, 131072); integer(gpuLayers, 0, 999);
  return { modelPath, alias, port, contextTokens, gpuLayers };
}
function parse(text: string): State {
  const value: unknown = JSON.parse(text);
  exact(value, ["schema", "apiKey", "preferences"]);
  check(value.schema === 1 && typeof value.apiKey === "string" && /^[a-f0-9]{64}$/u.test(value.apiKey));
  const state: State = { schema: 1, apiKey: value.apiKey, preferences: preferences(value.preferences) };
  // Exact canonical encoding also rejects duplicate JSON keys and invalid UTF-8.
  check(JSON.stringify(state) + "\n" === text);
  return state;
}
async function directory(path: string): Promise<void> {
  check(isAbsolute(path) && resolve(path) === path && basename(path) === ".abot-managed-llama");
  await canonicalManagedDirectory(path, true);
  if (process.platform !== "win32") check(privatePosixMode(await lstat(path), 0o700));
}
function serialize<T>(path: string, work: () => Promise<T>): Promise<T> {
  const result = (queues.get(path) ?? Promise.resolve()).catch(() => {}).then(work).catch(() => { throw failure(); });
  queues.set(path, result);
  void result.finally(() => { if (queues.get(path) === result) queues.delete(path); }).catch(() => {});
  return result;
}

/** Private server-side adapter; not a browser DTO or provider credential store.
 * Caller must first validate installer ownership and exclusively control ancestors.
 * Never creates/adopts storage or reads receipts. Construction is inert.
 * Canonical private storage: POSIX modes/nofollow or Windows NTFS/ACL checks.
 * File data is synced before atomic publication; directory fsync is POSIX-only.
 * Power-loss guarantees on Windows are filesystem-specific (as with sessions).
 * Cooperating writers use an exclusive private lock; stale locks fail closed (no
 * automatic recovery). Same-user hostile ancestor/file replacement is outside the
 * portable path-API guarantee. No process state or autostart intent is persisted.
 * A failure after publication may leave a
 * committed state, which is reused on retry, never rolled back to a different key.
 */
export class ManagedLlamaPersistence {
  constructor(private readonly directory: string) {}

  readPreferences(): Promise<LaunchSettings | null> {
    return serialize(this.directory, async () => {
      await directory(this.directory);
      const state = await this.readState();
      return state ? { ...state.preferences } : null;
    });
  }

  prepareStart(settings: LaunchSettings): Promise<{ apiKey: string }> {
    // Snapshot synchronously, before queuing, without retaining caller references.
    let snapshot: LaunchSettings;
    try { snapshot = preferences(settings); } catch { return Promise.reject(failure()); }
    return serialize(this.directory, async () => {
      await directory(this.directory);
      // Validate existing state before creating even a lock file.
      await this.readState();
      const lockPath = join(this.directory, "launch-state.lock");
      let lock: Awaited<ReturnType<typeof open>> | undefined;
      const deadline = performance.now() + 1000;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (attempt > 0 && performance.now() >= deadline) throw failure();
        try {
          lock = await createManagedFile(lockPath);
          break;
        } catch (error) {
          if (code(error) !== "EEXIST") throw error;
          const info = await lstat(lockPath).catch(error => { if (code(error) === "ENOENT") return null; throw error; });
          if (info) {
            check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
            await verifyPrivateManagedFile(lockPath, info, 0o600);
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      check(lock);
      try {
        await directory(this.directory);
        let state = await this.readState(); // Re-read first-write winner under lock.
        for (let attempt = 0; attempt < 2; attempt++) {
          const next: State = { schema: 1, apiKey: state?.apiKey ?? randomBytes(32).toString("hex"), preferences: snapshot };
          const published = await this.publish(next, state);
          if (published) return { apiKey: next.apiKey };
          state = await this.readState();
          check(state); // EEXIST is not permission to rotate or adopt unsafe state.
        }
        throw failure();
      } finally {
        await lock.close();
        // Only our successfully exclusively-created lock is removed.
        await directory(this.directory);
        await unlink(lockPath);
        await syncDirectory(this.directory);
      }
    });
  }

  private async readState(): Promise<State | null> {
    const path = join(this.directory, "launch-state.json");
    // lstat distinguishes a dangling symlink from an absent initial publication.
    let info;
    try { info = await lstat(path); } catch (error) { if (code(error) === "ENOENT") return null; throw error; }
    check(info.isFile() && !info.isSymbolicLink());
    const file = await openManagedRead(path);
    try {
      const stat = await file.stat();
      await verifyPrivateManagedFile(path, stat, 0o600);
      check(stat.nlink === 1 && stat.size > 0 && stat.size <= MAX_BYTES && stat.ino === info.ino && stat.dev === info.dev);
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const after = await file.stat();
      check(length === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      return parse(text);
    } finally { await file.close(); }
  }

  private async publish(next: State, previous: State | null): Promise<boolean> {
    const path = join(this.directory, "launch-state.json");
    const temporary = join(this.directory, ".launch-state-" + randomBytes(16).toString("hex") + ".tmp");
    const file = await createManagedFile(temporary);
    let temporaryExists = true;
    try {
      try {
        const stat = await file.stat();
        await verifyPrivateManagedFile(temporary, stat, 0o600);
        check(stat.nlink === 1);
        await file.writeFile(JSON.stringify(next) + "\n", "utf8");
        await file.sync();
      } finally { await file.close(); }
      await directory(this.directory);
      if (previous) {
        // Lock protects cooperating cross-process writers; detect other changes.
        check(JSON.stringify(await this.readState()) === JSON.stringify(previous));
        await rename(temporary, path);
        temporaryExists = false;
      } else {
        try { await link(temporary, path); }
        catch (error) { if (code(error) === "EEXIST") return false; throw error; }
        await unlink(temporary);
        temporaryExists = false;
      }
      await syncDirectory(this.directory);
      return true;
    } finally {
      if (temporaryExists) {
        await directory(this.directory);
        await unlink(temporary);
      }
    }
  }
}
