import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { settingsFailure } from "./contracts.js";

export type StoredSparkHomeSettings = Readonly<{
  schemaVersion: 1; revision: number; jobId: string | null;
  personalInstructions: string; modelProfileId: string | null; fullAccessGranted: boolean;
}>;
export const EMPTY_SPARK_HOME_SETTINGS: StoredSparkHomeSettings = Object.freeze({
  schemaVersion: 1, revision: 0, jobId: null, personalInstructions: "", modelProfileId: null, fullAccessGranted: false,
});

export function createSparkHomeSettingsStore(runtimeDirectory: string) {
  const directory = join(runtimeDirectory, "spark-home");
  const file = join(directory, "settings.json");
  return {
    async read(): Promise<StoredSparkHomeSettings> {
      let text: string;
      try { text = await readFile(file, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_SPARK_HOME_SETTINGS; throw error; }
      if (text.length > 32_768) return settingsFailure("spark_home_settings_invalid");
      let value: StoredSparkHomeSettings;
      try { value = JSON.parse(text) as StoredSparkHomeSettings; } catch { return settingsFailure("spark_home_settings_invalid"); }
      if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0)
        return settingsFailure("spark_home_settings_invalid");
      if (value.jobId !== null && (typeof value.jobId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.jobId)))
        return settingsFailure("spark_home_settings_invalid");
      if (typeof value.personalInstructions !== "string" || value.personalInstructions.length > 4000 || typeof value.fullAccessGranted !== "boolean")
        return settingsFailure("spark_home_settings_invalid");
      if (value.modelProfileId !== null && (typeof value.modelProfileId !== "string" || !value.modelProfileId.trim() || value.modelProfileId.length > 256))
        return settingsFailure("spark_home_settings_invalid");
      return value;
    },
    async write(value: StoredSparkHomeSettings): Promise<void> {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // Binding must survive a crash before any scheduler Job is created.
      await syncDirectoryPath(directory);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(value), "utf8"); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, file);
        await syncDirectory(directory);
      }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
    },
  };
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectoryPath(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  let current = resolve(directory);
  for (;;) {
    await syncDirectory(current);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
