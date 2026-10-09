import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../config/utils.js";

export type PluginLocalConfiguration = {
  settings: Record<string, unknown>;
  secrets: Record<string, { env: string; value: string | null }>;
};
export type PluginConfigurationStore = Record<string, PluginLocalConfiguration>;
export type PluginConfigurationSnapshot = {
  plugins: PluginConfigurationStore;
  raw: string | undefined;
  revision: string;
};
export const PLUGIN_CONFIGURATION_MAX_BYTES = 1024 * 1024;

export class PluginConfigurationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export function isMissingPluginConfiguration(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function pluginConfigurationPath(rootDir: string): string {
  return join(rootDir, ".runtime", "plugin-configuration.json");
}

export function requirePrivateConfigurationDirectory(rootDir: string): void {
  try {
    const info = lstatSync(join(rootDir, ".runtime"));
    if (info.isDirectory() && !info.isSymbolicLink()) return;
  } catch (error) {
    if (isMissingPluginConfiguration(error)) return;
    throw error;
  }
  throw new PluginConfigurationError(
    "unsafe_plugin_configuration",
    "Plugin configuration requires a local directory.",
    409,
  );
}

function isStoredPluginSecret(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.env !== "string") return false;
  return value.value === null || typeof value.value === "string";
}

function isStoredPluginConfiguration(
  value: unknown,
): value is PluginLocalConfiguration {
  if (!isRecord(value)) return false;
  if (!isRecord(value.settings)) return false;
  if (!isRecord(value.secrets)) return false;
  return Object.values(value.secrets).every(isStoredPluginSecret);
}

function parsePluginConfigurationStore(
  raw: string | undefined,
): PluginConfigurationStore {
  if (raw === undefined) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) throw new Error();
    if (value.version !== 1) throw new Error();
    if (!isRecord(value.plugins)) throw new Error();
    if (!Object.values(value.plugins).every(isStoredPluginConfiguration))
      throw new Error();
    return value.plugins as PluginConfigurationStore;
  } catch {
    throw new PluginConfigurationError(
      "invalid_plugin_configuration_file",
      "The local plugin configuration file could not be read.",
      409,
    );
  }
}

function requirePrivatePluginConfigurationPermissions(mode: number): void {
  if (process.platform === "win32") return;
  if ((mode & 0o077) === 0) return;
  throw new PluginConfigurationError(
    "unsafe_plugin_configuration",
    "Plugin configuration permissions are too open. Run chmod 600 on .runtime/plugin-configuration.json before retrying.",
    409,
  );
}

export function readPluginConfigurationStore(
  rootDir: string,
): PluginConfigurationSnapshot {
  requirePrivateConfigurationDirectory(rootDir);
  let raw: string | undefined;
  try {
    const path = pluginConfigurationPath(rootDir);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new PluginConfigurationError(
        "unsafe_plugin_configuration",
        "Plugin configuration must be a regular local file.",
        409,
      );
    requirePrivatePluginConfigurationPermissions(info.mode);
    if (info.size > PLUGIN_CONFIGURATION_MAX_BYTES)
      throw new PluginConfigurationError(
        "plugin_configuration_too_large",
        "The local plugin configuration file is too large.",
        409,
      );
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (!isMissingPluginConfiguration(error)) throw error;
  }
  return {
    plugins: parsePluginConfigurationStore(raw),
    raw,
    revision: createHash("sha256")
      .update(raw === undefined ? "missing" : `present:${raw}`)
      .digest("hex"),
  };
}
