import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { syncSessionDirectory } from "../../sessions/durable-session-commit.js";
import { SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import { parseRuntimeAttachmentReferences, type RuntimeAttachmentReference } from "../attachments/store.js";

function isMissingCleanupReceipt(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function parseCleanupReceipt(value: unknown): RuntimeAttachmentReference[] {
  if (!value || typeof value !== "object") throw new Error("spark_chat_cleanup_receipt_invalid");
  if (!("schemaVersion" in value) || value.schemaVersion !== 1) throw new Error("spark_chat_cleanup_receipt_invalid");
  if (!("sessionId" in value) || value.sessionId !== SPARK_SESSION_ID) throw new Error("spark_chat_cleanup_receipt_invalid");
  if (!("references" in value) || !Array.isArray(value.references)) throw new Error("spark_chat_cleanup_receipt_invalid");
  return parseRuntimeAttachmentReferences(value.references);
}

/** Exact pending deletions, accessed only while the owner holds SPARK admission. */
export function createSparkCleanupReceipt(runtimeDirectory: string) {
  const directory = join(runtimeDirectory, "spark-chat");
  const path = join(directory, "attachment-cleanup.json");
  return {
    async read(): Promise<RuntimeAttachmentReference[]> {
      try { return parseCleanupReceipt(JSON.parse(await readFile(path, "utf8"))); }
      catch (error) {
        if (isMissingCleanupReceipt(error)) return [];
        throw error;
      }
    },
    async save(references: RuntimeAttachmentReference[]): Promise<void> {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await syncSessionDirectory(dirname(directory));
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ schemaVersion: 1, sessionId: SPARK_SESSION_ID, references }));
          await handle.sync();
        } finally { await handle.close(); }
        await rename(temporary, path);
        await syncSessionDirectory(directory);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    },
    async complete(): Promise<void> {
      await rm(path, { force: true });
      await syncSessionDirectory(directory);
    },
  };
}
