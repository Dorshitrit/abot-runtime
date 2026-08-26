import { stat } from "node:fs/promises";
import { posix } from "node:path";

import type {
  ResolvedRuntimeToolPath,
  RuntimePluginLoadContext,
} from "../../../src/plugin-sdk/index.js";
import {
  isRuntimeToolPathError,
  readBoundedRegularFile,
  resolvePluginPath,
  sanitizeJsonText,
} from "../../../src/plugin-sdk/index.js";

const PACKAGE_JSON_MAX_BYTES = 256 * 1024;
const PACKAGE_SCRIPT_LIMIT = 100;
const MANIFEST_IDENTITY_MAX_CHARS = 256;
const SCRIPT_NAME_MAX_CHARS = 32;
const KNOWN_MANIFESTS = Object.freeze([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "tsconfig.json",
  "vite.config.ts",
  "vite.config.js",
]);

export type ProjectManifestSummary = Readonly<{
  file: string;
  name?: string;
  version?: string;
  private?: boolean;
  scripts?: readonly string[];
  scriptsTruncated?: boolean;
  status?: "invalid_json" | "too_large";
}>;

function logicalChild(parent: ResolvedRuntimeToolPath, name: string): string {
  return parent.logicalPath === "."
    ? name
    : posix.join(parent.logicalPath, name);
}

function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string"
    ? sanitizeJsonText(value).slice(0, MANIFEST_IDENTITY_MAX_CHARS)
    : undefined;
}

function boundedScriptName(value: string): string {
  return [...sanitizeJsonText(value)].slice(0, SCRIPT_NAME_MAX_CHARS).join("");
}

async function existingChild(
  context: RuntimePluginLoadContext,
  root: ResolvedRuntimeToolPath,
  name: string,
): Promise<ResolvedRuntimeToolPath | undefined> {
  try {
    const child = resolvePluginPath(context, logicalChild(root, name), {
      requirePath: true,
      allowedLocations: ["agent_work", "workspace"],
    });
    const info = await stat(child.absolutePath);
    return info.isFile() ? child : undefined;
  } catch (error) {
    if (isRuntimeToolPathError(error)) throw error;
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

export async function readProjectManifests(
  context: RuntimePluginLoadContext,
  root: ResolvedRuntimeToolPath,
): Promise<readonly ProjectManifestSummary[]> {
  const summaries: ProjectManifestSummary[] = [];
  for (const name of KNOWN_MANIFESTS) {
    const target = await existingChild(context, root, name);
    if (!target) continue;
    if (name !== "package.json") {
      summaries.push(Object.freeze({ file: name }));
      continue;
    }
    const file = await readBoundedRegularFile(target.absolutePath, {
      maxBytes: PACKAGE_JSON_MAX_BYTES,
      rootPath: target.rootPath,
    });
    if (!file.ok && file.reason === "too_large") {
      summaries.push(
        Object.freeze({ file: name, status: "too_large" as const }),
      );
      continue;
    }
    if (!file.ok)
      throw new Error("Project manifest changed while it was being read.");
    try {
      const parsed = JSON.parse(file.bytes.toString("utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        summaries.push(
          Object.freeze({ file: name, status: "invalid_json" as const }),
        );
        continue;
      }
      const record = parsed as Readonly<Record<string, unknown>>;
      const rawScriptNames =
        record.scripts &&
        typeof record.scripts === "object" &&
        !Array.isArray(record.scripts)
          ? Object.keys(record.scripts as Record<string, unknown>).sort(
              (left, right) => left.localeCompare(right),
            )
          : [];
      const scriptNames = rawScriptNames.map(boundedScriptName);
      summaries.push(
        Object.freeze({
          file: name,
          ...(stringField(record, "name")
            ? { name: stringField(record, "name") }
            : {}),
          ...(stringField(record, "version")
            ? { version: stringField(record, "version") }
            : {}),
          ...(record.private === true ? { private: true } : {}),
          scripts: Object.freeze(scriptNames.slice(0, PACKAGE_SCRIPT_LIMIT)),
          ...(rawScriptNames.length > PACKAGE_SCRIPT_LIMIT ||
          rawScriptNames.some((name, index) => name !== scriptNames[index])
            ? { scriptsTruncated: true }
            : {}),
        }),
      );
    } catch (error) {
      if (error instanceof SyntaxError) {
        summaries.push(
          Object.freeze({ file: name, status: "invalid_json" as const }),
        );
        continue;
      }
      throw error;
    }
  }
  return Object.freeze(summaries);
}
