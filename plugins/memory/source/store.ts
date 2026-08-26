import { randomUUID } from "node:crypto";
import { access, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  MemoryStoreError,
  type MemoryEntry,
  type MemoryStoreState,
} from "./types.js";
import { acquireStoreLock } from "./store-lock.js";

const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_STORE_ENTRIES = 2_000;

function parseEntry(value: unknown): MemoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryStoreError(
      "invalid_memory_store",
      "Memory store contains an invalid entry.",
    );
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    typeof record.id !== "string" ||
    record.id.trim().length === 0 ||
    typeof record.content !== "string" ||
    record.content.trim().length === 0 ||
    typeof record.createdAt !== "string" ||
    Number.isNaN(Date.parse(record.createdAt))
  ) {
    throw new MemoryStoreError(
      "invalid_memory_store",
      "Memory store contains an invalid entry.",
    );
  }
  return Object.freeze({
    id: record.id.trim(),
    content: record.content.trim(),
    createdAt: record.createdAt,
  });
}

function parseStore(raw: string): MemoryStoreState {
  if (Buffer.byteLength(raw, "utf8") > MAX_STORE_BYTES) {
    throw new MemoryStoreError(
      "memory_store_too_large",
      "Memory store exceeds its configured size limit.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new MemoryStoreError(
      "invalid_memory_store",
      "Memory store is not valid JSON.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MemoryStoreError(
      "invalid_memory_store",
      "Memory store must be a JSON object.",
    );
  }
  const entries = (parsed as Readonly<Record<string, unknown>>).entries;
  if (!Array.isArray(entries)) {
    throw new MemoryStoreError(
      "invalid_memory_store",
      "Memory store entries must be an array.",
    );
  }
  if (entries.length > MAX_STORE_ENTRIES) {
    throw new MemoryStoreError(
      "memory_store_capacity_exceeded",
      "Memory store exceeds its configured entry limit.",
    );
  }
  const validated = entries.map(parseEntry);
  const ids = new Set<string>();
  for (const entry of validated) {
    if (ids.has(entry.id)) {
      throw new MemoryStoreError(
        "invalid_memory_store",
        "Memory store contains duplicate IDs.",
      );
    }
    ids.add(entry.id);
  }
  const derivedNextSequence = nextSequenceAfter(validated);
  const persistedNextSequence = (parsed as Readonly<Record<string, unknown>>)
    .nextSequence;
  if (
    persistedNextSequence !== undefined &&
    (!Number.isSafeInteger(persistedNextSequence) ||
      Number(persistedNextSequence) < derivedNextSequence)
  ) {
    throw new MemoryStoreError(
      "invalid_memory_store",
      "Memory store nextSequence is invalid.",
    );
  }
  return Object.freeze({
    entries: Object.freeze(validated),
    nextSequence:
      persistedNextSequence === undefined
        ? derivedNextSequence
        : Number(persistedNextSequence),
  });
}

function serializeStore(state: MemoryStoreState): string {
  return `${JSON.stringify(
    { nextSequence: state.nextSequence, entries: state.entries },
    null,
    2,
  )}\n`;
}

async function atomicWrite(
  filePath: string,
  state: MemoryStoreState,
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const serialized = serializeStore(state);
  if (Buffer.byteLength(serialized, "utf8") > MAX_STORE_BYTES) {
    throw new MemoryStoreError(
      "memory_store_capacity_exceeded",
      "Memory store exceeds its configured size limit.",
    );
  }
  try {
    await writeFile(temporaryPath, serialized, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function nextSequenceAfter(entries: readonly MemoryEntry[]): number {
  let maximum = 0;
  for (const entry of entries) {
    const match = /^mem-(\d+)$/u.exec(entry.id);
    if (!match?.[1]) continue;
    const numeric = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(numeric)) maximum = Math.max(maximum, numeric);
  }
  return maximum + 1;
}

function memoryId(sequence: number): string {
  return `mem-${String(sequence).padStart(4, "0")}`;
}

function fileSystemErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function readStoreFile(filePath: string): Promise<MemoryStoreState> {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new MemoryStoreError(
        "invalid_memory_store",
        "Memory store must be a regular file.",
      );
    }
    if (info.size > MAX_STORE_BYTES) {
      throw new MemoryStoreError(
        "memory_store_too_large",
        "Memory store exceeds its configured size limit.",
      );
    }
    return parseStore(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

export class MemoryStore {
  readonly #filePath: string;
  readonly #legacyFilePaths: readonly string[];
  readonly #now: () => Date;
  #initialization: Promise<void> | undefined;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: {
    filePath: string;
    legacyFilePaths?: readonly string[];
    now?: () => Date;
  }) {
    this.#filePath = options.filePath;
    this.#legacyFilePaths = Object.freeze([...(options.legacyFilePaths ?? [])]);
    this.#now = options.now ?? (() => new Date());
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await acquireStoreLock(this.#filePath);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  #ensureInitialized(): Promise<void> {
    if (this.#initialization) return this.#initialization;
    const initialization = this.#withLock(() => this.#initialize());
    this.#initialization = initialization;
    void initialization.catch(() => {
      if (this.#initialization === initialization) {
        this.#initialization = undefined;
      }
    });
    return initialization;
  }

  async #initialize(): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    try {
      await access(this.#filePath);
      return;
    } catch (error) {
      if (fileSystemErrorCode(error) !== "ENOENT") {
        throw new MemoryStoreError(
          "memory_store_unavailable",
          "Memory store is unavailable.",
        );
      }
    }
    for (const legacyPath of this.#legacyFilePaths) {
      try {
        const legacy = await readStoreFile(legacyPath);
        await atomicWrite(this.#filePath, legacy);
        return;
      } catch (error) {
        if (error instanceof MemoryStoreError) throw error;
        if (fileSystemErrorCode(error) !== "ENOENT") {
          throw new MemoryStoreError(
            "memory_store_unavailable",
            "Memory store is unavailable.",
          );
        }
      }
    }
    await atomicWrite(
      this.#filePath,
      Object.freeze({ entries: Object.freeze([]), nextSequence: 1 }),
    );
  }

  async #load(): Promise<MemoryStoreState> {
    await this.#ensureInitialized();
    try {
      return await readStoreFile(this.#filePath);
    } catch (error) {
      if (error instanceof MemoryStoreError) throw error;
      throw new MemoryStoreError(
        "memory_store_unavailable",
        "Memory store is unavailable.",
      );
    }
  }

  async read(): Promise<MemoryStoreState> {
    await this.#mutationTail;
    return this.#load();
  }

  async #mutate<T>(
    mutation: (
      state: MemoryStoreState,
    ) => Readonly<{ state: MemoryStoreState; value: T }>,
  ): Promise<T> {
    const operation = this.#mutationTail.then(async () => {
      await this.#ensureInitialized();
      return this.#withLock(async () => {
        const current = await readStoreFile(this.#filePath);
        const next = mutation(current);
        await atomicWrite(this.#filePath, next.state);
        return next.value;
      });
    });
    this.#mutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  add(content: string): Promise<MemoryEntry> {
    return this.#mutate((current) => {
      if (current.entries.length >= MAX_STORE_ENTRIES) {
        throw new MemoryStoreError(
          "memory_store_capacity_exceeded",
          "Memory store exceeds its configured entry limit.",
        );
      }
      const entry = Object.freeze({
        id: memoryId(current.nextSequence),
        content,
        createdAt: this.#now().toISOString(),
      });
      return Object.freeze({
        state: Object.freeze({
          entries: Object.freeze([...current.entries, entry]),
          nextSequence: current.nextSequence + 1,
        }),
        value: entry,
      });
    });
  }

  delete(id: string): Promise<number> {
    return this.#mutate((current) => {
      const remaining = current.entries.filter((entry) => entry.id !== id);
      return Object.freeze({
        state: Object.freeze({
          entries: Object.freeze(remaining),
          nextSequence: current.nextSequence,
        }),
        value: current.entries.length - remaining.length,
      });
    });
  }
}
