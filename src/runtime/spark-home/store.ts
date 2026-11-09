import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../adapters/long-term-memory/file-lock.js";
import { fileSystemErrorCode } from "../adapters/long-term-memory/file-lock/contracts.js";
import {
  isSparkHomeHtml, isSparkHomeRevision, parseSavedSparkHome,
  SparkHomeError, SPARK_HOME_MAX_HTML_BYTES,
  type SavedSparkHomeSnapshot, type SparkHomeService, type SparkHomeSnapshot,
} from "./contracts.js";

// JSON can escape one HTML byte as six characters, plus the fixed record envelope.
const MAX_STORED_BYTES = SPARK_HOME_MAX_HTML_BYTES * 6 + 1024;

async function readScreen(file: string): Promise<SparkHomeSnapshot> {
  try {
    const handle = await open(file, "r");
    try {
      if ((await handle.stat()).size > MAX_STORED_BYTES)
        throw new SparkHomeError("spark_home_storage_invalid");
      return parseSavedSparkHome(JSON.parse(await handle.readFile("utf8")));
    } finally { await handle.close(); }
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT")
      return { revision: 0, html: null, updatedAt: null };
    if (error instanceof SparkHomeError) throw error;
    if (error instanceof SyntaxError) throw new SparkHomeError("spark_home_storage_invalid");
    throw new SparkHomeError("spark_home_storage_unavailable");
  }
}

async function replaceScreen(file: string, snapshot: SavedSparkHomeSnapshot, abortSignal?: AbortSignal): Promise<void> {
  abortSignal?.throwIfAborted();
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, ...snapshot }), "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    abortSignal?.throwIfAborted();
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

function assertSparkHomeUpdate(input: Readonly<{ expectedRevision: number; html: string }>): void {
  if (!isSparkHomeRevision(input.expectedRevision))
    throw new SparkHomeError("spark_home_revision_invalid");
  if (!isSparkHomeHtml(input.html)) throw new SparkHomeError("spark_home_html_invalid");
}

function hasExpectedSparkHomeRevision(previous: SparkHomeSnapshot, expectedRevision: number): boolean {
  return previous.revision === expectedRevision;
}

function canAdvanceSparkHomeRevision(previous: SparkHomeSnapshot): boolean {
  return previous.revision < Number.MAX_SAFE_INTEGER;
}

/** One environment-owned screen; chat clearing and ordinary artifact paths do not own it. */
export function createSparkHomeService(runtimeDirectory: string): SparkHomeService {
  const directory = join(runtimeDirectory, "spark-home");
  const file = join(directory, "screen.json");
  return Object.freeze({
    read: () => readScreen(file),
    async update(input: Readonly<{ expectedRevision: number; html: string }>,
      options?: Readonly<{ abortSignal?: AbortSignal }>) {
      assertSparkHomeUpdate(input);
      const abortSignal = options?.abortSignal;
      abortSignal?.throwIfAborted();
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        return await withFileLock(join(directory, "screen.lock"), async () => {
          abortSignal?.throwIfAborted();
          const previous = await readScreen(file);
          if (!hasExpectedSparkHomeRevision(previous, input.expectedRevision))
            throw new SparkHomeError("spark_home_revision_conflict");
          if (!canAdvanceSparkHomeRevision(previous))
            throw new SparkHomeError("spark_home_revision_exhausted");
          const next = { revision: previous.revision + 1, html: input.html, updatedAt: new Date().toISOString() };
          await replaceScreen(file, next, abortSignal);
          return next;
        });
      } catch (error) {
        abortSignal?.throwIfAborted();
        if (error instanceof SparkHomeError) throw error;
        throw new SparkHomeError("spark_home_storage_unavailable");
      }
    },
  });
}
