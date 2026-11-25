import { readFile, stat } from "node:fs/promises";
import type { ToolExecutionSharedState } from "../../capabilities/tool-types.js";
import { resolveRuntimeTargetPath, RuntimeToolPathError } from "../capabilities/runtime-target-path.js";

export type RegisteredToolPayloadTargetContextReason =
  | "missing" | "access_denied" | "not_file" | "read_failure";

const TARGET_FAILURE_EXPLANATIONS: Record<RegisteredToolPayloadTargetContextReason, string> = {
  missing: "The selected payload target does not exist. This operation requires an existing readable file.",
  access_denied: "Access to the selected payload target was denied. This operation requires permission to read that file.",
  not_file: "The selected payload target is not a regular file. This operation requires an existing readable file.",
  read_failure: "The selected payload target could not be read. Its contents are unavailable for this operation.",
};

/** Adapter-owned diagnostics retain only the selected logical target, never filesystem internals. */
export class RegisteredToolPayloadTargetContextError extends Error {
  readonly code: `payload_target_context_${RegisteredToolPayloadTargetContextReason}`;

  constructor(
    readonly reason: RegisteredToolPayloadTargetContextReason,
    readonly targetParam: string,
    readonly targetPath: string,
  ) {
    super(`${TARGET_FAILURE_EXPLANATIONS[reason]} No external operation was executed. Selected ${JSON.stringify(targetParam)}: ${JSON.stringify(targetPath)}.`);
    this.name = "RegisteredToolPayloadTargetContextError";
    this.code = `payload_target_context_${reason}`;
  }
}

export async function readRegisteredToolPayloadTarget(params: {
  targetParam: string;
  targetPath: string;
  sharedState: ToolExecutionSharedState;
}): Promise<string> {
  try {
    const resolvedTarget = resolveRuntimeTargetPath(params.targetPath, params.sharedState);
    const targetStat = await stat(resolvedTarget);
    if (!targetStat.isFile())
      throw new RegisteredToolPayloadTargetContextError("not_file", params.targetParam, params.targetPath);
    return await readFile(resolvedTarget, "utf8");
  } catch (error) {
    if (error instanceof RegisteredToolPayloadTargetContextError) throw error;
    throw new RegisteredToolPayloadTargetContextError(classifyTargetReadFailure(error), params.targetParam, params.targetPath);
  }
}

function classifyTargetReadFailure(error: unknown): RegisteredToolPayloadTargetContextReason {
  if (error instanceof RuntimeToolPathError)
    return isTargetPathAccessDenied(error) ? "access_denied" : "read_failure";
  if (!(error instanceof Error) || !("code" in error)) return "read_failure";
  if (error.code === "ENOENT") return "missing";
  if (error.code === "EACCES" || error.code === "EPERM") return "access_denied";
  if (error.code === "EISDIR" || error.code === "ENOTDIR") return "not_file";
  return "read_failure";
}

function isTargetPathAccessDenied(error: RuntimeToolPathError): boolean {
  if (error.filesystemFailure === "access_denied") return true;
  return [
    "runtime_tool_path_outside_configured_roots",
    "runtime_tool_path_symlink_escape",
    "runtime_tool_path_traversal",
    "runtime_tool_path_outside_working_directory",
  ].includes(error.code);
}
