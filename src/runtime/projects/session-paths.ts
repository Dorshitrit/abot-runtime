import type { SessionRecord } from "../../sessions/types.js";
import { copySessionProject } from "../../sessions/project-binding.js";
import type { RuntimePaths } from "../ports.js";

/** Derive only the request-local work root; all configured namespaces stay distinct. */
export function resolveSessionWorkingDirectory(
  session: SessionRecord,
): string | undefined {
  if (!session.project) return undefined;
  return copySessionProject(session.project).directory;
}

export function projectSessionRuntimePaths(
  paths: RuntimePaths,
  session: SessionRecord,
): RuntimePaths {
  const agentWorkDir = resolveSessionWorkingDirectory(session);
  if (!agentWorkDir) return paths;
  return Object.freeze({ ...paths, agentWorkDir });
}
