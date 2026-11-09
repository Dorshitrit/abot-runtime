export const SPARK_HOME_MAX_HTML_BYTES = 256 * 1024;

export type SparkHomeSnapshot = Readonly<{
  revision: number;
  html: string | null;
  updatedAt: string | null;
}>;
export type SavedSparkHomeSnapshot = Readonly<{
  revision: number;
  html: string;
  updatedAt: string;
}>;
export type SparkHomeService = Readonly<{
  read(): Promise<SparkHomeSnapshot>;
  update(input: Readonly<{ expectedRevision: number; html: string }>,
    options?: Readonly<{ abortSignal?: AbortSignal }>): Promise<SavedSparkHomeSnapshot>;
}>;
export type SparkHomeReader = Pick<SparkHomeService, "read">;

export class SparkHomeError extends Error {
  constructor(readonly code: string) { super(code); }
}

export function isSparkHomeRevision(value: unknown): value is number {
  if (!Number.isSafeInteger(value)) return false;
  return (value as number) >= 0;
}

export function isSparkHomeHtml(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value.trim()) return false;
  return Buffer.byteLength(value, "utf8") <= SPARK_HOME_MAX_HTML_BYTES;
}

/** Stored content is opaque untrusted HTML; rendering isolation belongs to the Web host. */
export function parseSavedSparkHome(value: unknown): SavedSparkHomeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SparkHomeError("spark_home_storage_invalid");
  const saved = value as Record<string, unknown>;
  if (saved.schemaVersion !== 1) throw new SparkHomeError("spark_home_storage_invalid");
  if (!isSparkHomeRevision(saved.revision) || saved.revision === 0)
    throw new SparkHomeError("spark_home_storage_invalid");
  if (!isSparkHomeHtml(saved.html)) throw new SparkHomeError("spark_home_storage_invalid");
  if (typeof saved.updatedAt !== "string" || !Number.isFinite(Date.parse(saved.updatedAt)))
    throw new SparkHomeError("spark_home_storage_invalid");
  return { revision: saved.revision, html: saved.html, updatedAt: saved.updatedAt };
}
