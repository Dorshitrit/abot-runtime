import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../../adapters/long-term-memory/file-lock.js";
import { fileSystemErrorCode } from "../../adapters/long-term-memory/file-lock/contracts.js";
import type { CoWorkerResourceUsage } from "./contracts.js";

const MAX_BUDGET_STATE_BYTES = 2_048;

function parseResourceUsage(value: unknown): CoWorkerResourceUsage {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("co_worker_budget_state_invalid");
  const state = value as CoWorkerResourceUsage;
  if (state.schemaVersion !== 1)
    throw new Error("co_worker_budget_state_invalid");
  if (!Number.isFinite(state.startedAt) || !Number.isFinite(state.resetsAt))
    throw new Error("co_worker_budget_state_invalid");
  if (state.resetsAt <= state.startedAt)
    throw new Error("co_worker_budget_state_invalid");
  const counters = [
    state.modelCalls,
    state.embeddingCalls,
    state.embeddingCharacters,
  ];
  if (counters.some((count) => !Number.isSafeInteger(count) || count < 0))
    throw new Error("co_worker_budget_state_invalid");
  if (typeof state.timeZone !== "string")
    throw new Error("co_worker_budget_state_invalid");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: state.timeZone }).format(0);
  } catch {
    throw new Error("co_worker_budget_state_invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    timeZone: state.timeZone,
    startedAt: state.startedAt,
    resetsAt: state.resetsAt,
    modelCalls: state.modelCalls,
    embeddingCalls: state.embeddingCalls,
    embeddingCharacters: state.embeddingCharacters,
  });
}

export function createCoWorkerResourceStore(directory: string) {
  const file = join(directory, "resource-budget.json");
  async function read(): Promise<CoWorkerResourceUsage | undefined> {
    try {
      const handle = await open(file, "r");
      try {
        const buffer = Buffer.alloc(MAX_BUDGET_STATE_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BUDGET_STATE_BYTES)
          throw new Error("co_worker_budget_state_too_large");
        return parseResourceUsage(
          JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
        );
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (fileSystemErrorCode(error) === "ENOENT") return undefined;
      throw error;
    }
  }
  async function write(state: CoWorkerResourceUsage): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(state));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return Object.freeze({
    read,
    async update(
      change: (
        previous: CoWorkerResourceUsage | undefined,
      ) => CoWorkerResourceUsage,
    ) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      return withFileLock(`${file}.lock`, async () => {
        const previous = await read();
        const changed = change(previous);
        if (changed === previous) return changed;
        const next = parseResourceUsage(changed);
        await write(next);
        return next;
      });
    },
  });
}
