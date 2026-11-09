import { stat } from "node:fs/promises";
import { posix } from "node:path";
import {
  resolvePluginPath,
  runtimeToolPathErrorCode,
  sanitizeJsonText,
  type ResolvedRuntimeToolPath,
  type RuntimePluginLoadContext,
} from "../../../src/plugin-sdk/index.js";

import {
  ProjectInspectionError,
  throwIfProjectInspectionCancelled,
} from "./inspection-failure.js";

export function resolveProjectEntry(
  context: RuntimePluginLoadContext,
  parent: ResolvedRuntimeToolPath,
  name: string,
): ResolvedRuntimeToolPath {
  const path = posix.join(parent.logicalPath, name);
  try {
    return resolvePluginPath(context, path, {
      requirePath: true,
      allowedLocations: ["agent_work", "workspace"],
    });
  } catch (error) {
    const code = runtimeToolPathErrorCode(error);
    if (code !== "runtime_tool_path_symlink_escape") throw error;
    const entry = JSON.stringify(sanitizeJsonText(name));
    throw new ProjectInspectionError(
      code,
      `Project scan stopped at ${entry}. The link target could not be verified within the allowed directory.`,
    );
  }
}

function isMissingProjectTarget(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Classify only the requested target lookup, never a disappearing child. */
export async function readProjectTargetInfo(
  absolutePath: string,
  signal?: AbortSignal,
) {
  try {
    return await stat(absolutePath);
  } catch (error) {
    throwIfProjectInspectionCancelled(signal);
    if (isMissingProjectTarget(error)) {
      throw new ProjectInspectionError(
        "project_target_not_found",
        "The requested project directory does not exist.",
      );
    }
    throw error;
  }
}
