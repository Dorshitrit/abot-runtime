import { isAbsolute } from "node:path";
import type { RuntimeFilesystemScope } from "../../context/runtime-filesystem-scope.js";
import {
  createRuntimeToolPathResolver,
  RuntimeToolPathError,
} from "../../capabilities/runtime-target-path.js";
import {
  normalizeRoleCallWorkingDirectory,
  ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH,
} from "../../orchestration/role-calls/working-directory.js";

function isPortableAgentWorkDirectory(path: string): boolean {
  // These spellings bind to the separate workspace namespace downstream.
  if (path === "workspace" || path.startsWith("workspace/")) return false;
  // A literal POSIX backslash (or drive-prefixed name) cannot round-trip.
  return normalizeRoleCallWorkingDirectory(path) === path;
}

/** Convert a model selection to the existing relative role-call contract. */
export function resolveSupervisorWorkingDirectory(
  value: unknown,
  scope?: RuntimeFilesystemScope,
): string | undefined {
  if (typeof value !== "string" || value.length > ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH)
    return undefined;
  const path = value.trim();
  // A missing model selection is sometimes stringified. An explicit ./null
  // (or an in-root absolute path) can still name a real directory.
  if (path === "null") return undefined;
  if (!isAbsolute(path)) return normalizeRoleCallWorkingDirectory(path);
  if (!scope || path.split(/[\\/]/u).includes("..")) return undefined;
  try {
    const resolver = createRuntimeToolPathResolver({ agentWorkDir: scope.agentWorkRoot });
    const { logicalPath } = resolver.resolve(path, { allowedLocations: ["agent_work"] });
    return isPortableAgentWorkDirectory(logicalPath) ? logicalPath : undefined;
  } catch (error) {
    if (error instanceof RuntimeToolPathError) return undefined;
    throw error;
  }
}
