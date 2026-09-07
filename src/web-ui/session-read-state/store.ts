import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type WebReadCursor = {
  messageId: string;
  createdAt: number;
  lastReadAt: number;
};
export type WebReadState = {
  version: 1;
  initializedAt: number;
  cursors: Array<[string, WebReadCursor]>;
};
const pendingWrites = new Map<string, Promise<unknown>>();

function hasFileErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isReadCursor(value: unknown): value is WebReadCursor {
  if (!value || typeof value !== "object") return false;
  const cursor = value as WebReadCursor;
  if (typeof cursor.messageId !== "string") return false;
  if (!Number.isFinite(cursor.createdAt)) return false;
  return Number.isFinite(cursor.lastReadAt);
}

function decodeReadState(raw: string): WebReadState {
  const state = JSON.parse(raw) as WebReadState;
  if (state?.version !== 1) throw new Error("Unsupported Web UI read state.");
  if (!Number.isFinite(state.initializedAt))
    throw new Error("Invalid Web UI read boundary.");
  if (!Array.isArray(state.cursors))
    throw new Error("Invalid Web UI read cursors.");
  for (const entry of state.cursors) {
    if (!Array.isArray(entry) || entry.length !== 2)
      throw new Error("Invalid Web UI read cursor entry.");
    if (typeof entry[0] !== "string" || !isReadCursor(entry[1]))
      throw new Error("Invalid Web UI read cursor entry.");
  }
  return state;
}

/** UI-owned state; never writes Runtime session records or model context. */
export class WebReadStateStore {
  private readonly path: string;

  constructor(
    path: string,
    private readonly initializedAt: number,
  ) {
    this.path = resolve(path);
  }

  private async load(): Promise<WebReadState | null> {
    try {
      return decodeReadState(await readFile(this.path, "utf8"));
    } catch (error) {
      if (hasFileErrorCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  private async save(state: WebReadState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state), "utf8");
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async transaction<T>(
    operation: (state: WebReadState) => T | Promise<T>,
  ): Promise<T> {
    const prior = pendingWrites.get(this.path) ?? Promise.resolve();
    const pending = prior
      .catch(() => undefined)
      .then(async () => {
        const existing = await this.load();
        const state = existing ?? {
          version: 1,
          initializedAt: this.initializedAt,
          cursors: [],
        };
        const before = JSON.stringify(state);
        const result = await operation(state);
        if (!existing || JSON.stringify(state) !== before)
          await this.save(state);
        return result;
      });
    pendingWrites.set(this.path, pending);
    try {
      return await pending;
    } finally {
      if (pendingWrites.get(this.path) === pending)
        pendingWrites.delete(this.path);
    }
  }

  initialize(): Promise<void> {
    return this.transaction(() => undefined);
  }

  reset(sessionId: string, now: number): Promise<void> {
    return this.transaction((state) => {
      const cursors = new Map(state.cursors);
      const previous = cursors.get(sessionId);
      cursors.set(sessionId, {
        messageId: "",
        createdAt: 0,
        lastReadAt: Math.max(
          now,
          (previous?.lastReadAt ?? state.initializedAt) + 1,
        ),
      });
      state.cursors = [...cursors];
    });
  }

  forget(sessionId: string): Promise<void> {
    return this.transaction((state) => {
      state.cursors = state.cursors.filter(([id]) => id !== sessionId);
    });
  }
}
