import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileSystemErrorCode } from "../../adapters/long-term-memory/file-lock/contracts.js";
import { homeGenerationFailure, type SparkHomeRunSnapshot, type SparkHomeRunStore } from "./contracts.js";

function decodeSparkHomeRun(value: unknown): SparkHomeRunSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return homeGenerationFailure("spark_home_run_storage_invalid");
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1) return homeGenerationFailure("spark_home_run_storage_invalid");
  if (typeof item.runId !== "string" || item.runId.length > 128) return homeGenerationFailure("spark_home_run_storage_invalid");
  if (!Number.isSafeInteger(item.revision) || Number(item.revision) < 1) return homeGenerationFailure("spark_home_run_storage_invalid");
  if (!["running", "awaiting_approval", "completed", "failed", "cancelled", "interrupted"].includes(String(item.status))) return homeGenerationFailure("spark_home_run_storage_invalid");
  if (!["plan", "collect", "followup", "compose", "publish"].includes(String(item.phase))) return homeGenerationFailure("spark_home_run_storage_invalid");
  for (const field of ["startedAt", "updatedAt"])
    if (typeof item[field] !== "string" || !Number.isFinite(Date.parse(String(item[field])))) return homeGenerationFailure("spark_home_run_storage_invalid");
  if (item.screenRevision !== null && (!Number.isSafeInteger(item.screenRevision) || Number(item.screenRevision) < 0)) return homeGenerationFailure("spark_home_run_storage_invalid");
  if (item.errorCode !== null && typeof item.errorCode !== "string") return homeGenerationFailure("spark_home_run_storage_invalid");
  // Pending action bytes and model context never enter this metadata store.
  return { runId: item.runId, revision: Number(item.revision), status: item.status as SparkHomeRunSnapshot["status"],
    phase: item.phase as SparkHomeRunSnapshot["phase"], startedAt: String(item.startedAt), updatedAt: String(item.updatedAt),
    screenRevision: item.screenRevision as number | null, pendingApproval: null, errorCode: item.errorCode as string | null };
}

export function createSparkHomeRunStore(runtimeDirectory: string): SparkHomeRunStore {
  const directory = join(runtimeDirectory, "spark-home");
  const file = join(directory, "last-run.json");
  return {
    async read() {
      try {
        const handle = await open(file, "r");
        try {
          if ((await handle.stat()).size > 8192) return homeGenerationFailure("spark_home_run_storage_invalid");
          return decodeSparkHomeRun(JSON.parse(await handle.readFile("utf8")));
        } finally { await handle.close(); }
      } catch (error) {
        if (fileSystemErrorCode(error) === "ENOENT") return null;
        throw error;
      }
    },
    async write(snapshot) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ schemaVersion: 1, ...snapshot, pendingApproval: null }), "utf8");
          await handle.sync();
        } finally { await handle.close(); }
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    },
  };
}
