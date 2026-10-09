import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { withFileLock } from "../adapters/long-term-memory/file-lock.js";
import {
  PLUGIN_CONFIGURATION_MAX_BYTES,
  PluginConfigurationError,
  pluginConfigurationPath,
  readPluginConfigurationStore,
  requirePrivateConfigurationDirectory,
  type PluginConfigurationSnapshot,
  type PluginConfigurationStore,
} from "./configuration-store.js";

/** Writers and Apply take the Runtime config lock before this installation-wide lock. */
export async function withPluginConfigurationLock<T>(
  rootDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const root = await realpath(rootDir);
  requirePrivateConfigurationDirectory(root);
  const path = pluginConfigurationPath(root);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  requirePrivateConfigurationDirectory(root);
  return withFileLock(`${path}.lock`, operation, {
    waitMs: Number.POSITIVE_INFINITY,
  });
}

function requireUnchangedPluginConfiguration(
  rootDir: string,
  expected: string | undefined,
): void {
  if (readPluginConfigurationStore(rootDir).raw === expected) return;
  throw new PluginConfigurationError(
    "plugin_configuration_changed",
    "Plugin configuration changed. Reload the form before saving.",
    409,
  );
}

async function replacePluginConfiguration(
  rootDir: string,
  expected: string | undefined,
  next: string | undefined,
): Promise<void> {
  const path = pluginConfigurationPath(rootDir);
  requireUnchangedPluginConfiguration(rootDir, expected);
  if (next === undefined) {
    await rm(path);
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, next, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    requireUnchangedPluginConfiguration(rootDir, expected);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Caller holds the installation-wide lock through commit and any restoration. */
export async function commitPluginConfigurationStore<T>(
  rootDir: string,
  previous: PluginConfigurationSnapshot,
  plugins: PluginConfigurationStore,
  commit: () => Promise<T>,
): Promise<T> {
  const next = JSON.stringify({ version: 1, plugins }, null, 2) + "\n";
  if (Buffer.byteLength(next) > PLUGIN_CONFIGURATION_MAX_BYTES)
    throw new PluginConfigurationError(
      "plugin_configuration_too_large",
      "Plugin configuration is too large.",
    );
  await replacePluginConfiguration(rootDir, previous.raw, next);
  try {
    return await commit();
  } catch (error) {
    try {
      await replacePluginConfiguration(rootDir, next, previous.raw);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Plugin configuration could not be restored after a failed save.",
      );
    }
    throw error;
  }
}
