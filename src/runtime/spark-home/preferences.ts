import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../adapters/long-term-memory/file-lock.js";
import { fileSystemErrorCode } from "../adapters/long-term-memory/file-lock/contracts.js";
import { SparkHomeError, isSparkHomeRevision } from "./contracts.js";

export type SparkHomeViewMode = "dashboard" | "spark_home";
export type SparkHomePreferences = Readonly<{ revision: number; mode: SparkHomeViewMode }>;
export type SparkHomePreferencesUpdate = Readonly<{ expectedRevision: number; mode: SparkHomeViewMode }>;
export interface SparkHomePreferencesService {
  read(): Promise<SparkHomePreferences>;
  update(input: SparkHomePreferencesUpdate): Promise<SparkHomePreferences>;
}

function isSparkHomeViewMode(value: unknown): value is SparkHomeViewMode {
  return value === "dashboard" || value === "spark_home";
}

export function parseSparkHomePreferencesUpdate(value: unknown): SparkHomePreferencesUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SparkHomeError("spark_home_preferences_invalid");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "expectedRevision" && key !== "mode") ||
      !isSparkHomeRevision(input.expectedRevision) || !isSparkHomeViewMode(input.mode))
    throw new SparkHomeError("spark_home_preferences_invalid");
  return Object.freeze({ expectedRevision: input.expectedRevision, mode: input.mode });
}

async function readSparkHomePreferences(file: string): Promise<SparkHomePreferences> {
  try {
    const handle = await open(file, "r");
    try {
      if ((await handle.stat()).size > 1024) throw new SparkHomeError("spark_home_preferences_invalid");
      const input = JSON.parse(await handle.readFile("utf8")) as Record<string, unknown>;
      if (!input || input.schemaVersion !== 1 || !isSparkHomeRevision(input.revision) || !isSparkHomeViewMode(input.mode))
        throw new SparkHomeError("spark_home_preferences_invalid");
      return Object.freeze({ revision: input.revision, mode: input.mode });
    } finally { await handle.close(); }
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return Object.freeze({ revision: 0, mode: "dashboard" });
    if (error instanceof SparkHomeError) throw error;
    throw new SparkHomeError("spark_home_preferences_unavailable");
  }
}

/** HOME navigation preference has its own durable owner and never changes Workspace client state. */
export function createSparkHomePreferencesService(runtimeDirectory: string): SparkHomePreferencesService {
  const directory = join(runtimeDirectory, "spark-home");
  const file = join(directory, "preferences.json");
  return Object.freeze({
    read: () => readSparkHomePreferences(file),
    async update(value: SparkHomePreferencesUpdate) {
      const input = parseSparkHomePreferencesUpdate(value);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      return withFileLock(join(directory, "preferences.lock"), async () => {
        const previous = await readSparkHomePreferences(file);
        if (previous.revision !== input.expectedRevision || previous.revision === Number.MAX_SAFE_INTEGER)
          throw new SparkHomeError("spark_home_preferences_conflict");
        const next = Object.freeze({ revision: previous.revision + 1, mode: input.mode });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          const handle = await open(temporary, "wx", 0o600);
          try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, ...next }), "utf8"); await handle.sync(); }
          finally { await handle.close(); }
          await rename(temporary, file);
        } finally { await rm(temporary, { force: true }).catch(() => {}); }
        return next;
      });
    },
  });
}
