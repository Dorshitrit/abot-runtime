import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_RUNTIME_CONFIG_FILE } from "./constants.js";
import type { RuntimeConfigFile } from "./types.js";
import { isRecord, resolveRuntimePath } from "./utils.js";
import { validateRuntimeConfigFile } from "./validation.js";

export type LoadedRuntimeConfigFile = {
  config: RuntimeConfigFile;
  path: string;
};

export type InspectedRuntimeConfigFile = LoadedRuntimeConfigFile & {
  exists: boolean;
};

/** A main-file parse failure. Native parser messages can quote private config values. */
export class InvalidRuntimeConfigJsonError extends Error {
  constructor(path: string, publicReason: string) {
    super(`Invalid runtime config JSON at ${path}: ${publicReason}`);
    this.name = "InvalidRuntimeConfigJsonError";
  }
}

function describeJsonSyntaxError(error: unknown): string {
  const message = error instanceof SyntaxError ? error.message : "";
  const location = /\(line (\d+) column (\d+)\)$/u.exec(message);
  const reason = message.startsWith("Unexpected end of JSON input")
    ? "Unexpected end of JSON input" : "Invalid JSON syntax";
  return location ? `${reason} (line ${location[1]} column ${location[2]})` : reason;
}

/** Reads and parses the config source without declaring it runnable. */
export function inspectRuntimeConfigFileWithMeta(
  rootDir: string,
  configPath?: string,
): InspectedRuntimeConfigFile {
  const resolvedPath = configPath
    ? resolveRuntimePath(rootDir, configPath)
    : join(rootDir, DEFAULT_RUNTIME_CONFIG_FILE);
  let raw = "";
  try {
    raw = readFileSync(resolvedPath, "utf-8");
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return { config: {}, path: resolvedPath, exists: false };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new InvalidRuntimeConfigJsonError(resolvedPath, describeJsonSyntaxError(error));
  }

  if (!isRecord(parsed)) {
    throw new InvalidRuntimeConfigJsonError(resolvedPath, "root must be an object");
  }

  return { config: parsed, path: resolvedPath, exists: true };
}

export function loadRuntimeConfigFileWithMeta(
  rootDir: string,
  configPath?: string,
): LoadedRuntimeConfigFile {
  const inspected = inspectRuntimeConfigFileWithMeta(rootDir, configPath);
  if (inspected.exists) {
    validateRuntimeConfigFile(inspected.config, inspected.path);
  }
  return { config: inspected.config, path: inspected.path };
}

export function loadRuntimeConfigFile(
  rootDir: string,
  configPath?: string,
): RuntimeConfigFile {
  return loadRuntimeConfigFileWithMeta(rootDir, configPath).config;
}
