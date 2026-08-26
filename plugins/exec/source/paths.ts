import { stat } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";

import {
  readRequiredString,
  resolvePluginPath,
  type ResolvedRuntimeToolPath,
  type RuntimePluginLoadContext,
  type ToolExecutionContext,
} from "../../../src/plugin-sdk/index.js";

import { ExecPluginError } from "./errors.js";

const EXEC_ALLOWED_LOCATIONS = Object.freeze([
  "agent_work",
  "workspace",
] as const);

function resolverContext(
  pluginContext: RuntimePluginLoadContext,
  executionContext: ToolExecutionContext | undefined,
): Pick<RuntimePluginLoadContext, "runtimePathResolver"> {
  return {
    runtimePathResolver:
      executionContext?.runtimePathResolver ??
      pluginContext.runtimePathResolver,
  };
}

export function resolveExecPath(
  pluginContext: RuntimePluginLoadContext,
  executionContext: ToolExecutionContext | undefined,
  rawPath: unknown,
): ResolvedRuntimeToolPath {
  return resolvePluginPath(
    resolverContext(pluginContext, executionContext),
    rawPath,
    {
      requirePath: true,
      allowedLocations: EXEC_ALLOWED_LOCATIONS,
    },
  );
}

export async function resolveExecWorkingDirectory(
  pluginContext: RuntimePluginLoadContext,
  executionContext: ToolExecutionContext | undefined,
  rawPath: unknown,
): Promise<ResolvedRuntimeToolPath> {
  const requestedPath = readRequiredString(rawPath, {
    name: "cwd",
    maxLength: 4_096,
  });
  const target = resolveExecPath(
    pluginContext,
    executionContext,
    requestedPath,
  );
  let info;
  try {
    info = await stat(target.absolutePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new ExecPluginError(
        "exec_cwd_not_found",
        "The selected cwd does not exist. Select an existing agent-work or workspace directory.",
      );
    }
    throw new ExecPluginError(
      "exec_cwd_inaccessible",
      "The selected cwd cannot be accessed by the runtime.",
    );
  }
  if (!info.isDirectory()) {
    throw new ExecPluginError(
      "exec_cwd_not_directory",
      "The selected cwd is not a directory.",
    );
  }
  return target;
}

export function resolveExecScopedPath(
  pluginContext: RuntimePluginLoadContext,
  executionContext: ToolExecutionContext | undefined,
  rawPath: string,
  cwd: ResolvedRuntimeToolPath,
): ResolvedRuntimeToolPath {
  const normalized = rawPath.replaceAll("\\", "/");
  const requested =
    isAbsolute(rawPath) ||
    normalized === "workspace" ||
    normalized.startsWith("workspace/")
      ? rawPath
      : posix.join(cwd.logicalPath, normalized || ".");
  return resolveExecPath(pluginContext, executionContext, requested);
}
