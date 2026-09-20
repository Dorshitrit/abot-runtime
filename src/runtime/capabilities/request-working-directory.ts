import { isAbsolute } from "node:path";
import type { ToolExecutionSharedState } from "../../capabilities/tool-types.js";

/** The immutable session root replaces only agent_work, never shared namespaces. */
export function bindRequestWorkingDirectory(
  state: ToolExecutionSharedState,
  directory?: string,
): ToolExecutionSharedState {
  if (directory === undefined) return state;
  if (!isAbsolute(directory))
    throw new TypeError("request_working_directory_absolute_required");
  return {
    ...state,
    runtimePaths: { ...state.runtimePaths, agentWorkDir: directory },
  };
}
